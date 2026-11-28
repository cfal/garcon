//! Wires process-local ownership, admission, and queue delivery through ports.
//! The server's LocalSet owns execution work. Assembly supplies committed
//! terminals through the subscription port and queues per-chat lifecycle
//! events after transcript publication.
//! Chat commands use [`ChatExecutionCommands`], read-only consumers use
//! [`ChatExecutionQueries`], and shutdown uses [`ChatExecutionLifecycle`].
//! These facets are declared in [`crate::types`]; the coordinator implements all three.

use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    error::Error,
    future::ready,
    rc::{Rc, Weak},
    task::{Context, Poll, Waker},
};

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError,
    errors::{DiagnosticError, ErrorInput, ErrorMetadata, error_metadata},
    keyed_lock::KeyedLock,
    log::{Logger, ScopedLogger, create_logger},
    unhandled_rejection_policy::UnhandledRejectionPolicy,
};
use garcon_contract::{
    agents::AgentExecutionPolicy,
    chat_stop::{ChatStopIntent, ChatStopOutcome, is_stop_satisfied},
    error_codes::ErrorCode,
    queue_state::AutomaticQueuePauseKind,
};
use garcon_interface::execution::AgentExecutionAdmission;
use garcon_js::clock::Clock;
use indexmap::IndexMap;
use tokio::sync::{oneshot, watch};

use crate::{
    accepted_input_handler::{
        AcceptedInputCoordinator, AcceptedInputDeps, AcceptedInputHandler, AcceptedSteerDelivery,
        aggregate_failure,
    },
    accepted_input_transcript::{AcceptedInputTranscript, AcceptedInputTranscriptPort},
    chat_execution_control_operations::{
        ChatExecutionControlOperations, ChatExecutionControlOperationsHost,
        QueueEntryMutationResult, QueueMoveResult,
    },
    chat_execution_control_repository::ChatExecutionControlRepository,
    chat_execution_control_transitions::{
        DeleteQueueEntryInput, FailurePauseCause, MoveQueueEntryInput, QueueCommandIdentity,
        QueueEntryInput, ReplaceQueueEntryInput,
    },
    control_input_delivery::{
        ControlInputDelivery, ControlInputDeliveryOptions, ControlInputSignal, ControlRunReserved,
    },
    control_state::{
        StoredChatExecutionControlState, StoredControlInputEntry, StoredQueueEntryStatus,
        has_pending_turn_input,
    },
    execution_attempt::QueueExecutionAttempt,
    execution_errors::{
        chat_not_found_error, control_input_blocked_error, server_shutting_down_error,
    },
    execution_ownership::{AdmissionAbortReason, ExecutionOwnership},
    queue_drainer::{
        QueueDispatchCallbacks, QueueDispatchDeps, QueueDrainOptionsResolver, QueueDrainer,
    },
    queued_steer_delivery::{
        QueuedSteerContent, QueuedSteerDelivery, QueuedSteerDeliveryOptions, QueuedSteerHost,
    },
    session_types::RunAgentTurnOptions,
    steer_input_delivery::{SteerInputDelivery, SteerInputDeliveryHost, SteerInputDeliveryOptions},
    turn_finalization_tracker::QueuedTurnFinalization,
    turn_identity::{TurnCommandType, TurnIdentity},
    turn_terminal_settlement::{
        AgentTurnSettlementOutcome, InterruptAgentTurnHost, TerminalSettlementDependencies,
        TerminalSettlementHost, TurnEventMetadata, WorkingDirectorySettlement,
        WorkingDirectorySettlementPort, interrupt_agent_turn, settle_agent_turn,
    },
    types::*,
};

#[async_trait(?Send)]
pub trait ChatExecutionCoordinatorHost {
    fn chat_exists(&self, chat_id: &str) -> bool;
    fn can_dispatch(&self, chat_id: &str) -> bool;
    fn is_control_input_view_current(
        &self,
        chat_id: &str,
        view_id: &str,
    ) -> ExecutionOperationResult<bool>;
    fn execution_policy(&self, _chat_id: &str) -> AgentExecutionPolicy {
        AgentExecutionPolicy::Conversation
    }
    fn unsettled_queue_receipt_keys(&self, _chat_id: &str) -> HashSet<String> {
        HashSet::new()
    }
    fn append_control_receipt(
        &self,
        _chat_id: &str,
        _entry: &StoredControlInputEntry,
    ) -> ExecutionOperationResult<()> {
        Ok(())
    }
    async fn resolve_steer_content(
        &self,
        input: QueuedSteerContent<'_>,
    ) -> ExecutionOperationResult<String> {
        Ok(input.content.into())
    }
}

pub struct ChatExecutionCoordinatorOptions {
    pub host: Rc<dyn ChatExecutionCoordinatorHost>,
    pub working_directory_settlement: Option<Rc<dyn WorkingDirectorySettlementPort>>,
    pub project_admission: Rc<dyn ProjectAdmissionPort>,
    pub attachment_admission: Rc<dyn QueuedAttachmentAdmissionPort>,
    pub selection_admission_lock: Rc<KeyedLock>,
    pub unhandled_rejections: Rc<UnhandledRejectionPolicy>,
}

pub struct ChatExecutionCoordinatorDeps {
    pub turn_runner: Rc<dyn AgentTurnRunnerPort>,
    pub input_transcript: Rc<dyn AcceptedInputTranscriptPort>,
    pub get_drain_options: Rc<QueueDrainOptionsResolver>,
    pub controls: Rc<dyn ChatExecutionControlRepository>,
    pub options: ChatExecutionCoordinatorOptions,
}

pub type RunEndedCommittedListener = Rc<dyn Fn(&str, &str)>;

pub trait RunEndedCommittedSource {
    fn subscribe_run_ended_committed(
        &self,
        listener: RunEndedCommittedListener,
    ) -> Box<dyn FnOnce()>;
}

enum CoordinatorEvent<'a> {
    ExecutionControlUpdated(&'a str, &'a StoredChatExecutionControlState),
    SessionStopped(
        &'a str,
        ChatStopOutcome,
        ChatStopIntent,
        Option<&'a TurnIdentity>,
    ),
    ChatIdle(&'a str),
    ProjectUnavailable(&'a str, &'a DomainError),
    TurnFailed(&'a str, &'a str, &'a RunAgentTurnOptions),
    TurnSettled(&'a str, &'a TurnIdentity),
    ProcessingInvalidated(&'a str),
    InputAccepted(&'a str, Option<&'a str>),
    TurnStarted(&'a str, &'a str),
}

type Listener = Rc<dyn for<'a> Fn(CoordinatorEvent<'a>) -> ExecutionOperationResult<()>>;

impl Copy for CoordinatorEvent<'_> {}
impl Clone for CoordinatorEvent<'_> {
    fn clone(&self) -> Self {
        *self
    }
}

struct TrackedTask<T: Clone> {
    done: watch::Sender<Option<Result<T, AdmissionAbortReason>>>,
    waiters: Cell<usize>,
}

impl<T: Clone> TrackedTask<T> {
    fn new() -> Self {
        Self {
            done: watch::Sender::new(None),
            waiters: Cell::new(0),
        }
    }

    async fn wait(&self) -> ExecutionOperationResult<T> {
        struct Waiting<'a>(&'a Cell<usize>);
        impl Drop for Waiting<'_> {
            fn drop(&mut self) {
                self.0.set(self.0.get() - 1);
            }
        }
        self.waiters.set(self.waiters.get() + 1);
        let waiting = Waiting(&self.waiters);
        let mut receiver = self.done.subscribe();
        // INFALLIBLE: the waiter retains the sender and waits only for a completed result.
        let result = receiver
            .wait_for(Option::is_some)
            .await
            .expect("tracked task sender remains alive")
            .clone()
            .expect("tracked task completed");
        drop(waiting);
        result.map_err(shared_error)
    }
}

#[derive(Debug)]
pub(crate) struct SharedCoordinatorError(AdmissionAbortReason);

impl std::fmt::Display for SharedCoordinatorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::error::Error for SharedCoordinatorError {}

impl DiagnosticError for SharedCoordinatorError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        let error = self.0.as_ref().as_ref();
        match execution_error_input(error) {
            ErrorInput::Diagnostic(error) => error.diagnostic_metadata(),
            _ => error_metadata(error),
        }
    }
}

fn shared_error(error: AdmissionAbortReason) -> Box<dyn Error> {
    Rc::try_unwrap(error).unwrap_or_else(|shared| Box::new(SharedCoordinatorError(shared)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectOutcome {
    Released,
    Completed,
    Failed,
}

pub struct ChatExecutionCoordinator {
    self_ref: Weak<Self>,
    locks: Rc<KeyedLock>,
    shutting_down: Cell<bool>,
    ownership: Rc<ExecutionOwnership>,
    dispatch_tasks: RefCell<IndexMap<u64, Rc<TrackedTask<()>>>>,
    next_task: Cell<u64>,
    stop_tasks: RefCell<IndexMap<String, Rc<TrackedTask<ChatStopOutcome>>>>,
    turn_runner: Rc<dyn AgentTurnRunnerPort>,
    get_drain_options: Rc<QueueDrainOptionsResolver>,
    options: ChatExecutionCoordinatorOptions,
    queue_drainer: QueueDrainer,
    controls: Rc<ChatExecutionControlOperations>,
    accepted_input: AcceptedInputHandler,
    input_transcript: AcceptedInputTranscript,
    steer_input: Rc<SteerInputDelivery>,
    queued_steers: Rc<QueuedSteerDelivery>,
    control_input: ControlInputDelivery,
    listeners: RefCell<Vec<Listener>>,
    new_id: Rc<dyn Fn() -> String>,
    logger: ScopedLogger,
}

struct CoordinatorPorts(Weak<ChatExecutionCoordinator>);

impl CoordinatorPorts {
    fn owner(&self) -> ExecutionOperationResult<Rc<ChatExecutionCoordinator>> {
        self.0
            .upgrade()
            .ok_or_else(|| Box::new(server_shutting_down_error()) as Box<dyn Error>)
    }
}

impl ChatExecutionCoordinator {
    pub fn new(
        deps: ChatExecutionCoordinatorDeps,
        clock: Rc<dyn Clock>,
        new_id: impl Fn() -> String + 'static,
        performance_now: impl Fn() -> f64 + 'static,
    ) -> Rc<Self> {
        let new_id: Rc<dyn Fn() -> String> = Rc::new(new_id);
        Rc::new_cyclic(|self_ref| {
            let ports = Rc::new(CoordinatorPorts(self_ref.clone()));
            let locks = Rc::new(KeyedLock::new());
            let ownership = Rc::new(ExecutionOwnership::new({
                let new_id = new_id.clone();
                move || new_id()
            }));
            let input_transcript =
                AcceptedInputTranscript::new(deps.input_transcript, clock.clone());
            let controls = Rc::new(ChatExecutionControlOperations::new(
                deps.controls,
                locks.clone(),
                ports.clone(),
                deps.options.project_admission.clone(),
                deps.options.attachment_admission.clone(),
                clock,
                {
                    let new_id = new_id.clone();
                    move || new_id()
                },
            ));
            let steer_input = Rc::new(SteerInputDelivery::new(
                SteerInputDeliveryOptions {
                    turn_runner: deps.turn_runner.clone(),
                    ownership: ownership.clone(),
                    host: ports.clone(),
                },
                {
                    let new_id = new_id.clone();
                    move || new_id()
                },
            ));
            let queued_steers = Rc::new(QueuedSteerDelivery::new(
                QueuedSteerDeliveryOptions {
                    controls: controls.clone(),
                    steer_input: steer_input.clone(),
                    host: ports.clone(),
                },
                {
                    let new_id = new_id.clone();
                    move || new_id()
                },
            ));
            let control_input = ControlInputDelivery::new(ports.clone());
            let accepted_input = AcceptedInputHandler::new(
                AcceptedInputDeps {
                    controls: controls.clone(),
                    coordinator: ports.clone(),
                    project_admission: deps.options.project_admission.clone(),
                },
                performance_now,
                {
                    let new_id = new_id.clone();
                    move || new_id()
                },
            );
            let queue_drainer = QueueDrainer::new(
                QueueDispatchDeps {
                    ownership: ownership.clone(),
                    controls: controls.clone(),
                    turn_runner: deps.turn_runner.clone(),
                    get_drain_options: Box::new({
                        let resolve = deps.get_drain_options.clone();
                        move |chat| resolve(chat)
                    }),
                    selection_admission: deps.options.selection_admission_lock.clone(),
                    project_admission: deps.options.project_admission.clone(),
                    attachment_admission: deps.options.attachment_admission.clone(),
                    callbacks: ports,
                },
                {
                    let new_id = new_id.clone();
                    move || new_id()
                },
            );
            Self {
                self_ref: self_ref.clone(),
                locks,
                shutting_down: Cell::new(false),
                ownership,
                dispatch_tasks: RefCell::default(),
                next_task: Cell::new(0),
                stop_tasks: RefCell::default(),
                turn_runner: deps.turn_runner,
                get_drain_options: deps.get_drain_options,
                options: deps.options,
                queue_drainer,
                controls,
                accepted_input,
                input_transcript,
                steer_input,
                queued_steers,
                control_input,
                listeners: RefCell::default(),
                new_id,
                logger: create_logger("queue"),
            }
        })
    }

    fn owned(&self) -> Rc<Self> {
        // INFALLIBLE: only the Rc constructor creates a coordinator.
        self.self_ref.upgrade().expect("coordinator is owned by Rc")
    }

    fn listen(
        &self,
        listener: impl for<'a> Fn(CoordinatorEvent<'a>) -> ExecutionOperationResult<()> + 'static,
    ) {
        self.listeners.borrow_mut().push(Rc::new(listener));
    }

    fn emit(&self, event: CoordinatorEvent<'_>) -> ExecutionOperationResult<()> {
        let listeners = self.listeners.borrow().clone();
        for listener in listeners {
            listener(event)?;
        }
        Ok(())
    }

    pub fn on_execution_control_updated(
        &self,
        callback: impl Fn(&str, &StoredChatExecutionControlState) -> ExecutionOperationResult<()>
        + 'static,
    ) {
        self.listen(move |event| {
            if let CoordinatorEvent::ExecutionControlUpdated(chat, control) = event {
                callback(chat, control)
            } else {
                Ok(())
            }
        });
    }

    pub fn on_session_stopped(
        &self,
        callback: impl Fn(
            &str,
            ChatStopOutcome,
            ChatStopIntent,
            Option<&TurnIdentity>,
        ) -> ExecutionOperationResult<()>
        + 'static,
    ) {
        self.listen(move |event| {
            if let CoordinatorEvent::SessionStopped(chat, outcome, intent, turn) = event {
                callback(chat, outcome, intent, turn)
            } else {
                Ok(())
            }
        });
    }

    pub fn on_chat_idle(&self, callback: impl Fn(&str) -> ExecutionOperationResult<()> + 'static) {
        self.listen(move |event| {
            if let CoordinatorEvent::ChatIdle(chat) = event {
                callback(chat)
            } else {
                Ok(())
            }
        });
    }

    pub fn on_project_unavailable(
        &self,
        callback: impl Fn(&str, &DomainError) -> ExecutionOperationResult<()> + 'static,
    ) {
        self.listen(move |event| {
            if let CoordinatorEvent::ProjectUnavailable(chat, error) = event {
                callback(chat, error)
            } else {
                Ok(())
            }
        });
    }

    pub fn on_turn_failed(
        &self,
        callback: impl Fn(&str, &str, &RunAgentTurnOptions) -> ExecutionOperationResult<()> + 'static,
    ) {
        self.listen(move |event| {
            if let CoordinatorEvent::TurnFailed(chat, message, options) = event {
                callback(chat, message, options)
            } else {
                Ok(())
            }
        });
    }

    pub fn on_turn_settled(
        &self,
        callback: impl Fn(&str, &TurnIdentity) -> ExecutionOperationResult<()> + 'static,
    ) {
        self.listen(move |event| {
            if let CoordinatorEvent::TurnSettled(chat, turn) = event {
                callback(chat, turn)
            } else {
                Ok(())
            }
        });
    }

    pub fn on_processing_invalidated(
        &self,
        callback: impl Fn(&str) -> ExecutionOperationResult<()> + 'static,
    ) {
        self.listen(move |event| {
            if let CoordinatorEvent::ProcessingInvalidated(chat) = event {
                callback(chat)
            } else {
                Ok(())
            }
        });
    }

    pub fn on_input_accepted(
        &self,
        callback: impl Fn(&str, Option<&str>) -> ExecutionOperationResult<()> + 'static,
    ) {
        self.listen(move |event| {
            if let CoordinatorEvent::InputAccepted(chat, run) = event {
                callback(chat, run)
            } else {
                Ok(())
            }
        });
    }

    pub fn on_turn_started(
        &self,
        callback: impl Fn(&str, &str) -> ExecutionOperationResult<()> + 'static,
    ) {
        self.listen(move |event| {
            if let CoordinatorEvent::TurnStarted(chat, run) = event {
                callback(chat, run)
            } else {
                Ok(())
            }
        });
    }

    pub fn subscribe_run_ended_committed(
        &self,
        source: &dyn RunEndedCommittedSource,
    ) -> Box<dyn FnOnce()> {
        let owner = self.self_ref.clone();
        source.subscribe_run_ended_committed(Rc::new(move |chat, run| {
            if let Some(owner) = owner.upgrade() {
                owner.mark_run_terminal_committed(chat, run);
            }
        }))
    }

    // Dropping an HTTP waiter must not cancel an admission, dispatch, or Stop.
    async fn owned_operation<T: 'static>(
        &self,
        mut operation: LocalExecutionFuture<'static, T>,
    ) -> ExecutionOperationResult<T> {
        // Promise work starts before it is handed off. Register FIFO lock
        // waiters and run synchronous admission before the next task runs.
        if let Poll::Ready(result) = poll_once(&mut operation) {
            return result;
        }
        let errors = self.options.unhandled_rejections.clone();
        let (done, result) = oneshot::channel();
        tokio::task::spawn_local(async move {
            if let Err(Err(error)) = done.send(operation.await) {
                errors.report(execution_error_input(error.as_ref()));
            }
        });
        result.await?
    }

    fn track_dispatch(&self, mut task: LocalExecutionFuture<'static>) {
        let owner = self.owned();
        let id = self.next_task.get();
        self.next_task.set(id.wrapping_add(1));
        let tracked = Rc::new(TrackedTask::new());
        self.dispatch_tasks.borrow_mut().insert(id, tracked.clone());
        let first = poll_once(&mut task);
        tokio::task::spawn_local(async move {
            let result = match first {
                Poll::Ready(result) => result,
                Poll::Pending => task.await,
            };
            if let Err(error) = &result
                && tracked.waiters.get() == 0
            {
                owner
                    .options
                    .unhandled_rejections
                    .report(execution_error_input(error.as_ref()));
            }
            tracked.done.send_replace(Some(result.map_err(Rc::new)));
            owner.dispatch_tasks.borrow_mut().shift_remove(&id);
        });
    }

    pub fn begin_shutdown(&self) -> Vec<String> {
        self.shutting_down.set(true);
        self.ownership.begin_shutdown(&shutdown_reason())
    }

    pub async fn abort_for_shutdown(&self, chat_id: &str) -> ExecutionOperationResult<bool> {
        self.ownership.abort_admission(chat_id, &shutdown_reason());
        Ok(is_stop_satisfied(
            self.request_stop(chat_id, ChatStopIntent::Stop)
                .wait()
                .await?,
        ))
    }

    pub async fn wait_for_execution_owners(&self) {
        self.ownership.wait_for_owners().await;
    }

    pub async fn wait_for_dispatches(&self) -> ExecutionOperationResult<()> {
        loop {
            let tasks: Vec<_> = self.dispatch_tasks.borrow().values().cloned().collect();
            if tasks.is_empty() {
                return Ok(());
            }
            futures::future::try_join_all(tasks.iter().map(|task| task.wait())).await?;
        }
    }

    pub async fn on_agent_turn_terminal(
        &self,
        chat_id: &str,
        turn: Option<&TurnEventMetadata>,
        outcome: AgentTurnSettlementOutcome,
    ) -> ExecutionOperationResult<WorkingDirectorySettlement> {
        settle_agent_turn(
            TerminalSettlementDependencies {
                ownership: &self.ownership,
                control: self.controls.as_ref(),
                working_directory: self.options.working_directory_settlement.as_deref(),
                host: self,
            },
            chat_id,
            turn,
            outcome,
        )
        .await
    }

    pub fn mark_run_terminal_committed(&self, chat_id: &str, run_id: &str) {
        self.ownership.mark_run_terminal_committed(chat_id, run_id);
    }

    pub fn replace_turn_with_transcript_snapshot_reservation(
        &self,
        chat_id: &str,
        turn: &TurnIdentity,
    ) -> Option<TranscriptSnapshotReservation> {
        self.ownership
            .replace_turn_with_transcript_snapshot(chat_id, turn)
    }

    pub fn get_queued_turn_finalization(
        &self,
        chat_id: &str,
        turn_id: Option<&str>,
    ) -> Option<QueuedTurnFinalization> {
        self.ownership.finalization(chat_id, turn_id)
    }

    pub async fn check_chat_idle(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        if self.shutting_down.get()
            || self.ownership.is_draining(chat_id)
            || self.turn_runner.is_chat_running(chat_id)
        {
            return Ok(());
        }
        let control = self.read_chat_execution_control(chat_id).await?;
        if self.is_drain_suppressed(chat_id) {
            if !has_pending_turn_input(&control) {
                self.ownership.consume_drain_request(chat_id);
                self.emit(CoordinatorEvent::ChatIdle(chat_id))?;
            }
            return Ok(());
        }
        let blocked = control.pause.is_some() || !self.options.host.can_dispatch(chat_id);
        if !blocked
            && (!control.control_entries.is_empty()
                || control
                    .entries
                    .iter()
                    .any(|entry| entry.status == StoredQueueEntryStatus::Queued))
        {
            return self.trigger_drain(chat_id).await;
        }
        if blocked || !has_pending_turn_input(&control) {
            self.ownership.consume_drain_request(chat_id);
            self.emit(CoordinatorEvent::ChatIdle(chat_id))?;
        }
        Ok(())
    }

    pub fn retry_queued_steers(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        self.queued_steers.retry(chat_id)
    }

    pub async fn read_chat_execution_control(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.controls.read(chat_id).await
    }

    pub async fn create_chat_queue_entry(
        &self,
        chat_id: &str,
        content: String,
        command: Option<QueueCommandIdentity>,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        self.controls
            .create(
                chat_id,
                &QueueEntryInput {
                    content,
                    images: Vec::new(),
                    command,
                    submission: None,
                },
                None,
            )
            .await
    }

    pub async fn replace_chat_queue_entry(
        &self,
        chat_id: &str,
        input: &ReplaceQueueEntryInput,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        self.controls.replace(chat_id, input).await
    }

    pub async fn delete_chat_queue_entry(
        &self,
        chat_id: &str,
        input: &DeleteQueueEntryInput,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        self.controls.delete(chat_id, input).await
    }

    pub async fn move_chat_queue_entry(
        &self,
        chat_id: &str,
        input: &MoveQueueEntryInput,
    ) -> ExecutionOperationResult<QueueMoveResult> {
        self.controls.move_entry(chat_id, input).await
    }

    pub async fn deliver_control_input(
        &self,
        chat_id: &str,
        content: &str,
        transcript_view_id: &str,
        emitting_run_id: Option<&str>,
        signal: ControlInputSignal<'_>,
        on_control_run: ControlRunReserved<'_>,
    ) -> ExecutionOperationResult<()> {
        self.control_input
            .deliver(
                chat_id,
                content,
                transcript_view_id,
                emitting_run_id,
                signal,
                on_control_run,
            )
            .await
    }

    pub async fn deliver_server_control_input(
        &self,
        chat_id: &str,
        input: ServerControlInput,
        signal: ControlInputSignal<'_>,
    ) -> ExecutionOperationResult<ServerControlDisposition> {
        match self
            .offer_server_control_input(chat_id, &input, signal, None)
            .await?
        {
            ServerControlOffer::Delivered => Ok(ServerControlDisposition::Delivered),
            ServerControlOffer::Queued => Ok(ServerControlDisposition::Queued),
            ServerControlOffer::AfterTurn { attempt } => {
                tokio::select! {
                    biased;
                    () = signal.token.cancelled() => return Err((signal.reason)()),
                    () = attempt.wait_until_settled() => {}
                }
                self.queue_server_control_input(chat_id, &input, signal)
                    .await
            }
        }
    }

    pub async fn offer_server_control_input(
        &self,
        chat_id: &str,
        input: &ServerControlInput,
        signal: ControlInputSignal<'_>,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<ServerControlOffer> {
        self.check_server_control(chat_id, signal)?;
        let control = self.controls.read(chat_id).await?;
        signal.check()?;
        if control.pause.is_none()
            && control.control_entries.is_empty()
            && let Some(target) = self
                .steer_input
                .capture_control_target(chat_id, deadline)
                .await
        {
            return Ok(
                match self
                    .control_input
                    .offer_to_captured_target(
                        chat_id,
                        &input.content,
                        &input.transcript_view_id,
                        &target,
                        signal,
                    )
                    .await?
                {
                    CapturedControlOffer::Delivered => ServerControlOffer::Delivered,
                    CapturedControlOffer::AfterTurn { attempt } => {
                        ServerControlOffer::AfterTurn { attempt }
                    }
                },
            );
        }
        self.queue_server_control_input(chat_id, input, signal)
            .await?;
        Ok(ServerControlOffer::Queued)
    }

    fn check_server_control(
        &self,
        chat_id: &str,
        signal: ControlInputSignal<'_>,
    ) -> ExecutionOperationResult<()> {
        signal.check()?;
        if self.shutting_down.get() {
            return Err(Box::new(server_shutting_down_error()));
        }
        if !self.options.host.chat_exists(chat_id) {
            return Err(Box::new(chat_not_found_error()));
        }
        Ok(())
    }

    pub async fn queue_server_control_input(
        &self,
        chat_id: &str,
        input: &ServerControlInput,
        signal: ControlInputSignal<'_>,
    ) -> ExecutionOperationResult<ServerControlDisposition> {
        self.check_server_control(chat_id, signal)?;
        let owner = self.owned();
        let (chat_id, input) = (chat_id.to_owned(), input.clone());
        self.owned_operation(Box::pin(async move {
            owner.controls.enqueue_control(&chat_id, &input).await?;
            owner.request_drain(&chat_id, "server control input")?;
            Ok(ServerControlDisposition::Queued)
        }))
        .await
    }

    pub async fn admit_user_input(
        &self,
        chat_id: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        let inserted = self
            .input_transcript
            .register(chat_id, content, options)
            .await?;
        if inserted {
            self.emit(CoordinatorEvent::InputAccepted(
                chat_id,
                options.turn_id.as_deref(),
            ))?;
        }
        Ok(inserted)
    }

    pub fn reserve_direct_turn(
        &self,
        chat_id: &str,
        turn: &TurnIdentity,
    ) -> ExecutionOperationResult<DirectTurnReservation> {
        self.assert_unowned(chat_id)?;
        let reservation = self.ownership.reserve_direct(chat_id, turn)?;
        if let Some(id) = turn.turn_id.as_deref().filter(|id| !id.is_empty()) {
            self.emit(CoordinatorEvent::TurnStarted(chat_id, id))?;
        }
        self.invalidate_processing(chat_id)?;
        Ok(reservation)
    }

    pub fn assert_direct_turn_reservation_active(
        &self,
        reservation: &DirectTurnReservation,
    ) -> ExecutionOperationResult<()> {
        if !self.ownership.is_direct_current(reservation) {
            return Err(Box::new(DomainError::new(
                ErrorCode::SESSION_BUSY,
                "Direct turn reservation is no longer active",
                409,
                true,
            )));
        }
        Ok(())
    }

    fn assert_unowned(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        if self.shutting_down.get() {
            return Err(Box::new(server_shutting_down_error()));
        }
        if self.owns_execution(chat_id) {
            return Err(Box::new(DomainError::new(
                ErrorCode::SESSION_BUSY,
                "Another chat turn already owns execution",
                409,
                true,
            )));
        }
        Ok(())
    }

    pub fn owns_execution(&self, chat_id: &str) -> bool {
        self.ownership.has_owner(chat_id) || self.turn_runner.is_chat_running(chat_id)
    }

    pub async fn run_reserved_turn(
        &self,
        reservation: DirectTurnReservation,
        content: String,
        options: RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner
                .run_direct(&reservation, &content, options, None, None)
                .await
        }))
        .await
    }

    pub async fn release_direct_turn(
        &self,
        reservation: &DirectTurnReservation,
    ) -> ExecutionOperationResult<()> {
        self.finish_direct_owned(reservation, DirectOutcome::Released)
            .await
    }

    pub async fn complete_direct_turn(
        &self,
        reservation: &DirectTurnReservation,
    ) -> ExecutionOperationResult<()> {
        self.finish_direct_owned(reservation, DirectOutcome::Completed)
            .await
    }

    pub async fn fail_direct_turn(
        &self,
        reservation: &DirectTurnReservation,
    ) -> ExecutionOperationResult<()> {
        self.finish_direct_owned(reservation, DirectOutcome::Failed)
            .await
    }

    async fn finish_direct_owned(
        &self,
        reservation: &DirectTurnReservation,
        outcome: DirectOutcome,
    ) -> ExecutionOperationResult<()> {
        let owner = self.owned();
        let reservation = reservation.clone();
        self.owned_operation(Box::pin(async move {
            owner.finish_direct(&reservation, outcome).await
        }))
        .await
    }

    pub async fn requeue_and_pause_chat(
        &self,
        chat_id: &str,
        entry_id: &str,
        kind: AutomaticQueuePauseKind,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.controls
            .requeue_and_pause(chat_id, entry_id, kind)
            .await
    }

    fn invalidate_processing(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        self.emit(CoordinatorEvent::ProcessingInvalidated(chat_id))
    }

    fn is_drain_suppressed(&self, chat_id: &str) -> bool {
        self.ownership
            .has_suppression(chat_id, DrainSuppressionReason::Abort)
            || self
                .ownership
                .has_suppression(chat_id, DrainSuppressionReason::Deletion)
    }

    fn request_drain(&self, chat_id: &str, context: &str) -> ExecutionOperationResult<()> {
        self.ownership.request_drain(chat_id);
        if let Some(task) = self.prepare_drain(chat_id)? {
            let context = context.to_owned();
            let logger = self.logger.clone();
            tokio::task::spawn_local(async move {
                if let Err(error) = task.await {
                    logger.error(&format!("queue: {context} drain error: {error}"));
                }
            });
        }
        Ok(())
    }

    pub async fn trigger_drain(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        if let Some(task) = self.prepare_drain(chat_id)? {
            self.owned_operation(task).await?;
        }
        Ok(())
    }

    fn prepare_drain(
        &self,
        chat_id: &str,
    ) -> ExecutionOperationResult<Option<LocalExecutionFuture<'static>>> {
        if self.shutting_down.get() {
            return Ok(None);
        }
        if self.ownership.has_direct(chat_id)
            || self.ownership.has_transcript_snapshot(chat_id)
            || self.ownership.is_draining(chat_id)
            || self.ownership.has_attempt(chat_id)
        {
            self.ownership.request_drain(chat_id);
            return Ok(None);
        }
        if self.is_drain_suppressed(chat_id) || self.turn_runner.is_chat_running(chat_id) {
            return Ok(None);
        }
        self.ownership.consume_drain_request(chat_id);
        self.ownership.begin_drain(chat_id)?;
        self.ownership.consume_drain_request(chat_id);
        let owner = self.owned();
        let chat_id = chat_id.to_owned();
        Ok(Some(Box::pin(async move {
            let result = owner.queue_drainer.run(&chat_id).await;
            owner.ownership.end_drain(&chat_id);
            owner.ownership.exit_manual_stop(&chat_id, false);
            owner.ownership.notify_owners_changed();
            owner.invalidate_processing(&chat_id)?;
            result?;
            if !owner.shutting_down.get() && owner.ownership.has_drain_request(&chat_id) {
                owner.check_chat_idle(&chat_id).await?;
            }
            Ok(())
        })))
    }

    fn retire_attempt(
        &self,
        chat_id: &str,
        attempt: &Rc<QueueExecutionAttempt>,
        reason: Option<&AdmissionAbortReason>,
    ) -> ExecutionOperationResult<()> {
        if self.ownership.retire_attempt(chat_id, attempt, reason) {
            self.emit(CoordinatorEvent::TurnSettled(chat_id, &attempt.identity()))?;
            self.ownership.notify_owners_changed();
        }
        Ok(())
    }

    async fn finish_direct(
        &self,
        reservation: &DirectTurnReservation,
        outcome: DirectOutcome,
    ) -> ExecutionOperationResult<()> {
        if !self.ownership.is_direct_current(reservation) {
            return Ok(());
        }
        let chat = &reservation.chat_id;
        let attempt = self.ownership.attempt(chat);
        let pause = if outcome == DirectOutcome::Failed
            && !attempt.as_ref().is_some_and(|a| a.has_terminal_commit())
            && self.options.host.chat_exists(chat)
            && self.options.host.execution_policy(chat) == AgentExecutionPolicy::Literal
            && let Some(turn_id) = attempt.as_ref().and_then(|a| a.identity().turn_id)
        {
            self.controls
                .pause_after_failure(chat, &FailurePauseCause::TurnFailed { turn_id })
                .await
                .map(|_| ())
        } else {
            Ok(())
        };
        if !self.ownership.is_direct_current(reservation) {
            return pause;
        }
        self.ownership.release_direct(reservation);
        if let Some(attempt) = attempt
            && outcome != DirectOutcome::Completed
            && !(attempt.has_terminal_commit() && self.options.host.chat_exists(chat))
            && !self.turn_runner.is_chat_running(chat)
        {
            self.retire_attempt(chat, &attempt, None)?;
        }
        self.ownership.notify_owners_changed();
        self.invalidate_processing(chat)?;
        pause?;
        if !self.options.host.chat_exists(chat) || self.shutting_down.get() {
            return Ok(());
        }
        if outcome != DirectOutcome::Released || self.ownership.has_drain_request(chat) {
            let result = if outcome == DirectOutcome::Failed {
                self.check_chat_idle(chat).await
            } else {
                self.trigger_drain(chat).await
            };
            if let Err(error) = result {
                self.logger
                    .error(&format!("queue: direct completion drain error: {error}"));
            }
        }
        Ok(())
    }

    async fn run_direct(
        &self,
        reservation: &DirectTurnReservation,
        content: &str,
        options: RunAgentTurnOptions,
        dispatch: Option<DirectDispatch>,
        before_failure_release: Option<BeforeFailureRelease>,
    ) -> ExecutionOperationResult<()> {
        self.assert_direct_turn_reservation_active(reservation)?;
        let chat = &reservation.chat_id;
        let identity = execution_turn_identity(&options.identity());
        let attempt = self
            .ownership
            .attempt(chat)
            .ok_or_else(|| std::io::Error::other("Direct turn execution attempt is missing"))?;
        if let Some(identity) = identity
            && !attempt.matches(Some(&identity))
        {
            attempt.replace_reserved_turn(identity)?;
        }
        attempt.mark_launching();
        let dispatched = async {
            check_admission(reservation)?;
            if let Some(dispatch) = dispatch {
                dispatch(reservation.execution_admission.clone()).await
            } else {
                let dispatched_options = RunAgentTurnOptions {
                    execution_admission: Some(reservation.execution_admission.clone()),
                    ..options.clone()
                };
                self.turn_runner
                    .run_agent_turn(chat, content, dispatched_options)
                    .await
            }
        }
        .await;
        let (outcome, result) = match dispatched {
            Ok(()) => (DirectOutcome::Completed, Ok(())),
            Err(error) => {
                let mut failure = error;
                if let Some(cleanup) = before_failure_release {
                    let shared = Rc::new(failure);
                    failure = match cleanup(shared.clone()).await {
                        Ok(()) => shared_error(shared),
                        Err(error) => aggregate_failure(
                            shared,
                            error,
                            format!("Direct input cleanup failed for {chat}"),
                        ),
                    };
                }
                let publish = if reservation.execution_admission.signal().is_cancelled() {
                    Ok(())
                } else {
                    self.emit(CoordinatorEvent::TurnFailed(
                        chat,
                        &failure.to_string(),
                        &options,
                    ))
                };
                (DirectOutcome::Failed, publish.and(Err(failure)))
            }
        };
        self.input_transcript
            .discard(chat, options.client_message_id.as_deref())?;
        self.finish_direct(reservation, outcome).await?;
        result
    }

    async fn schedule_control_run(
        &self,
        chat: &str,
        content: &str,
        view: &str,
        on_reserved: ControlRunReserved<'_>,
    ) -> ExecutionOperationResult<()> {
        let client_request_id = (self.new_id)();
        let turn_id = (self.new_id)();
        let reservation = self.reserve_direct_turn(
            chat,
            &TurnIdentity {
                client_request_id: Some(client_request_id.clone()),
                turn_id: Some(turn_id.clone()),
            },
        )?;
        // The callback borrows the caller's state. The guard releases a reservation
        // if that caller stops waiting before the hidden run can be scheduled.
        let mut guard = PendingControlReservation {
            owner: self.owned(),
            reservation: Some(reservation.clone()),
        };
        let options = async {
            self.assert_direct_turn_reservation_active(&reservation)?;
            if self.is_drain_suppressed(chat) || !self.options.host.chat_exists(chat) {
                return Err(Box::new(control_input_blocked_error()) as Box<dyn Error>);
            }
            check_admission(&reservation)?;
            let control = self.controls.read(chat).await?;
            self.assert_direct_turn_reservation_active(&reservation)?;
            check_admission(&reservation)?;
            if has_pending_turn_input(&control) || control.pause.is_some() {
                return Err(Box::new(control_input_blocked_error()));
            }
            self.options
                .project_admission
                .assert_available(chat, None)
                .await?;
            let selection = self
                .options
                .selection_admission_lock
                .run_exclusive_with_abort_reason(
                    &format!("chat:{chat}"),
                    || ready((self.get_drain_options)(chat)),
                    reservation.execution_admission.signal(),
                    || admission_error(&reservation),
                )
                .await??;
            self.assert_direct_turn_reservation_active(&reservation)?;
            check_admission(&reservation)?;
            let options = RunAgentTurnOptions {
                client_request_id: Some(client_request_id),
                client_message_id: Some((self.new_id)()),
                transcript_view_id: Some(view.into()),
                turn_id: Some(turn_id.clone()),
                command_type: Some(TurnCommandType::AgentRun),
                ..selection
            };
            on_reserved(&turn_id)?;
            Ok(options)
        }
        .await;
        guard.reservation = None;
        let options = match options {
            Ok(options) => options,
            Err(failure) => {
                return match self.release_direct_turn(&reservation).await {
                    Ok(()) => Err(failure),
                    Err(error) => Err(aggregate_failure(
                        Rc::new(failure),
                        error,
                        format!("Failed to release control turn for {chat}"),
                    )),
                };
            }
        };
        let owner = self.owned();
        let content = content.to_owned();
        self.track_dispatch(Box::pin(async move {
            if let Err(error) = owner
                .run_direct(&reservation, &content, options, None, None)
                .await
            {
                owner
                    .logger
                    .error(&format!("queue: Server control turn failed: {error}"));
            }
            Ok(())
        }));
        Ok(())
    }

    fn request_stop(
        &self,
        chat_id: &str,
        intent: ChatStopIntent,
    ) -> Rc<TrackedTask<ChatStopOutcome>> {
        if let Some(task) = self.stop_tasks.borrow().get(chat_id) {
            return task.clone();
        }
        let interrupted = self.ownership.attempt(chat_id).map(|a| a.identity());
        let task = Rc::new(TrackedTask::new());
        self.stop_tasks
            .borrow_mut()
            .insert(chat_id.into(), task.clone());
        let owner = self.owned();
        let chat = chat_id.to_owned();
        let running = task.clone();
        let mut interrupt: LocalExecutionFuture<'static, ChatStopOutcome> = Box::pin({
            let owner = owner.clone();
            let chat = chat.clone();
            async move { interrupt_agent_turn(&owner.ownership, owner.as_ref(), &chat).await }
        });
        let first = poll_once(&mut interrupt);
        tokio::task::spawn_local(async move {
            let stopped = match first {
                Poll::Ready(outcome) => outcome,
                Poll::Pending => interrupt.await,
            };
            let outcome = match stopped {
                Ok(outcome) => outcome,
                Err(error) => {
                    owner.logger.warn(&format!(
                        "queue: provider interrupt failed ({chat}): {}",
                        match execution_error_input(error.as_ref()) {
                            ErrorInput::Diagnostic(error) => error.diagnostic_metadata().name,
                            _ => error_metadata(error.as_ref()).name,
                        }
                    ));
                    ChatStopOutcome::Failed
                }
            };
            let result = owner.emit(CoordinatorEvent::SessionStopped(
                &chat,
                outcome,
                intent,
                interrupted.as_ref(),
            ));
            owner.stop_tasks.borrow_mut().shift_remove(&chat);
            let result = owner
                .invalidate_processing(&chat)
                .and(result)
                .map(|()| outcome);
            if let Err(error) = &result
                && running.waiters.get() == 0
            {
                owner
                    .options
                    .unhandled_rejections
                    .report(execution_error_input(error.as_ref()));
            }
            running.done.send_replace(Some(result.map_err(Rc::new)));
        });
        task
    }

    async fn stop(&self, chat_id: &str) -> ExecutionOperationResult<StopActiveTurnResult> {
        let drain_was_active = self.ownership.is_draining(chat_id);
        self.ownership.enter_abort_suppression(chat_id);
        self.ownership.enter_manual_stop(chat_id);
        let (outcome, drain_still_active) = match self.controls.pause(chat_id).await {
            Ok(_) => {
                let outcome = self
                    .request_stop(chat_id, ChatStopIntent::Stop)
                    .wait()
                    .await;
                (
                    outcome,
                    drain_was_active && self.ownership.is_draining(chat_id),
                )
            }
            Err(error) => (Err(error), false),
        };
        self.ownership.clear_abort_suppression(chat_id);
        self.ownership.exit_manual_stop(chat_id, drain_still_active);
        if self.ownership.has_drain_request(chat_id) {
            self.request_drain(chat_id, "stop suppression release")?;
        }
        Ok(StopActiveTurnResult {
            outcome: outcome?,
            control: self.read_chat_execution_control(chat_id).await?,
        })
    }

    fn rollback_deletion(&self, chat_id: &str) -> ExecutionOperationResult<()> {
        self.ownership.clear_deletion_suppression(chat_id);
        self.request_drain(chat_id, "deletion rollback")
    }
}

struct PendingControlReservation {
    owner: Rc<ChatExecutionCoordinator>,
    reservation: Option<DirectTurnReservation>,
}

impl Drop for PendingControlReservation {
    fn drop(&mut self) {
        if let Some(reservation) = self.reservation.take() {
            let owner = self.owner.clone();
            tokio::task::spawn_local(async move {
                if let Err(error) = owner
                    .finish_direct(&reservation, DirectOutcome::Released)
                    .await
                {
                    owner
                        .options
                        .unhandled_rejections
                        .report(execution_error_input(error.as_ref()));
                }
            });
        }
    }
}

fn shutdown_reason() -> AdmissionAbortReason {
    Rc::new(Box::new(std::io::Error::other(
        "Turn interrupted because the server is shutting down",
    )))
}

fn poll_once<T>(task: &mut LocalExecutionFuture<'_, T>) -> Poll<ExecutionOperationResult<T>> {
    task.as_mut().poll(&mut Context::from_waker(Waker::noop()))
}

fn admission_error(reservation: &DirectTurnReservation) -> Box<dyn Error> {
    reservation.execution_admission.abort_reason().map_or_else(
        || Box::new(garcon_base::keyed_lock::LockAborted) as Box<dyn Error>,
        shared_error,
    )
}

fn check_admission(reservation: &DirectTurnReservation) -> ExecutionOperationResult<()> {
    if reservation.execution_admission.signal().is_cancelled() {
        return Err(admission_error(reservation));
    }
    Ok(())
}

#[async_trait(?Send)]
impl TerminalSettlementHost for ChatExecutionCoordinator {
    fn execution_policy(&self, chat: &str) -> ExecutionOperationResult<AgentExecutionPolicy> {
        Ok(self.options.host.execution_policy(chat))
    }

    fn retire(
        &self,
        chat: &str,
        attempt: &Rc<QueueExecutionAttempt>,
    ) -> ExecutionOperationResult<()> {
        self.retire_attempt(chat, attempt, None)?;
        self.invalidate_processing(chat)
    }

    async fn check_idle(&self, chat: &str) -> ExecutionOperationResult<()> {
        self.check_chat_idle(chat).await
    }
}

#[async_trait(?Send)]
impl InterruptAgentTurnHost for ChatExecutionCoordinator {
    async fn abort_session(&self, chat: &str) -> ExecutionOperationResult<bool> {
        self.turn_runner.abort_session(chat).await
    }

    fn retire(
        &self,
        chat: &str,
        attempt: &Rc<QueueExecutionAttempt>,
        reason: &AdmissionAbortReason,
    ) -> ExecutionOperationResult<()> {
        self.retire_attempt(chat, attempt, Some(reason))
    }
}

impl ChatExecutionControlOperationsHost for CoordinatorPorts {
    fn chat_exists(&self, chat: &str) -> bool {
        self.0
            .upgrade()
            .is_some_and(|owner| owner.options.host.chat_exists(chat))
    }

    fn unsettled_queue_receipt_keys(&self, chat: &str) -> HashSet<String> {
        self.0.upgrade().map_or_else(HashSet::new, |owner| {
            owner.options.host.unsettled_queue_receipt_keys(chat)
        })
    }

    fn publish(
        &self,
        chat: &str,
        control: &StoredChatExecutionControlState,
    ) -> ExecutionOperationResult<()> {
        let owner = self.owner()?;
        owner.queued_steers.observe(chat, control)?;
        owner.emit(CoordinatorEvent::ExecutionControlUpdated(chat, control))
    }

    fn input_accepted(&self, chat: &str) -> ExecutionOperationResult<()> {
        self.owner()?
            .emit(CoordinatorEvent::InputAccepted(chat, None))
    }
}

#[async_trait(?Send)]
impl SteerInputDeliveryHost for CoordinatorPorts {
    fn is_shutting_down(&self) -> bool {
        self.0
            .upgrade()
            .is_none_or(|owner| owner.shutting_down.get())
    }

    async fn admit_input(
        &self,
        chat: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        self.owner()?.admit_user_input(chat, content, options).await
    }

    fn discard_prepared_input(
        &self,
        chat: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        self.owner()?
            .input_transcript
            .discard(chat, client_message_id)
    }
}

#[async_trait(?Send)]
impl QueuedSteerHost for CoordinatorPorts {
    async fn resolve_content(
        &self,
        input: QueuedSteerContent<'_>,
    ) -> ExecutionOperationResult<String> {
        self.owner()?
            .options
            .host
            .resolve_steer_content(input)
            .await
    }

    fn can_deliver(&self, chat: &str) -> bool {
        self.0
            .upgrade()
            .is_some_and(|owner| !owner.shutting_down.get() && owner.options.host.chat_exists(chat))
    }

    fn request_drain(&self, chat: &str, context: &str) -> ExecutionOperationResult<()> {
        self.owner()?.request_drain(chat, context)
    }

    fn track_task(&self, task: LocalExecutionFuture<'static>) -> ExecutionOperationResult<()> {
        self.owner()?.track_dispatch(task);
        Ok(())
    }
}

#[async_trait(?Send)]
impl ControlInputDeliveryOptions for CoordinatorPorts {
    async fn capture_target(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<Option<CapturedSteerTarget>> {
        Ok(self
            .owner()?
            .steer_input
            .capture_control_target(chat, None)
            .await)
    }

    async fn deliver_steer(
        &self,
        chat: &str,
        content: &str,
        view: &str,
        target: &CapturedSteerTarget,
    ) -> ExecutionOperationResult<()> {
        self.owner()?
            .steer_input
            .deliver_control(chat, content, view, target)
            .await
    }

    async fn schedule_run(
        &self,
        chat: &str,
        content: &str,
        view: &str,
        on_reserved: ControlRunReserved<'_>,
    ) -> ExecutionOperationResult<()> {
        self.owner()?
            .schedule_control_run(chat, content, view, on_reserved)
            .await
    }
}

#[async_trait(?Send)]
impl AcceptedInputCoordinator for CoordinatorPorts {
    fn request_drain(&self, chat: &str, context: &str) -> ExecutionOperationResult<()> {
        self.owner()?.request_drain(chat, context)
    }

    fn reserve_direct(
        &self,
        chat: &str,
        turn: &TurnIdentity,
    ) -> ExecutionOperationResult<DirectTurnReservation> {
        self.owner()?.reserve_direct_turn(chat, turn)
    }

    fn checkpoint(&self, reservation: &DirectTurnReservation) -> ExecutionOperationResult<()> {
        self.owner()?
            .assert_direct_turn_reservation_active(reservation)?;
        check_admission(reservation)
    }

    fn has_matching_input(
        &self,
        chat: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        self.owner()?
            .input_transcript
            .has_matching(chat, content, options)
    }

    async fn admit_input(
        &self,
        chat: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        SteerInputDeliveryHost::admit_input(self, chat, content, options).await
    }

    fn discard_prepared_input(
        &self,
        chat: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        SteerInputDeliveryHost::discard_prepared_input(self, chat, client_message_id)
    }

    async fn release_direct(
        &self,
        reservation: &DirectTurnReservation,
    ) -> ExecutionOperationResult<()> {
        self.owner()?
            .finish_direct(reservation, DirectOutcome::Released)
            .await
    }

    fn run_direct(
        self: Rc<Self>,
        reservation: DirectTurnReservation,
        content: String,
        options: RunAgentTurnOptions,
        dispatch: Option<DirectDispatch>,
        before_failure_release: Option<BeforeFailureRelease>,
    ) -> LocalExecutionFuture<'static> {
        Box::pin(async move {
            self.owner()?
                .run_direct(
                    &reservation,
                    &content,
                    options,
                    dispatch,
                    before_failure_release,
                )
                .await
        })
    }

    fn track_dispatch(&self, task: LocalExecutionFuture<'static>) -> ExecutionOperationResult<()> {
        self.owner()?.track_dispatch(task);
        Ok(())
    }

    async fn steer(
        &self,
        input: AcceptedSteerDelivery<'_>,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome> {
        self.owner()?.steer_input.deliver(input).await
    }
}

impl QueueDispatchCallbacks for CoordinatorPorts {
    fn can_dispatch(&self, chat: &str) -> bool {
        self.0
            .upgrade()
            .is_some_and(|owner| owner.options.host.can_dispatch(chat))
    }

    fn is_shutting_down(&self) -> bool {
        SteerInputDeliveryHost::is_shutting_down(self)
    }

    fn register_queued(
        &self,
        chat: &str,
        content: &str,
        options: &RunAgentTurnOptions,
    ) -> ExecutionOperationResult<bool> {
        self.owner()?.input_transcript.register_queued(
            chat,
            content,
            &UserInputAdmissionOptions::from_run_options(options, None),
        )
    }

    fn append_control_receipt(
        &self,
        chat: &str,
        entry: &StoredControlInputEntry,
    ) -> ExecutionOperationResult<()> {
        self.owner()?
            .options
            .host
            .append_control_receipt(chat, entry)
    }

    fn is_control_input_view_current(
        &self,
        chat: &str,
        view: &str,
    ) -> ExecutionOperationResult<bool> {
        self.owner()?
            .options
            .host
            .is_control_input_view_current(chat, view)
    }

    fn discard_prepared_input(
        &self,
        chat: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        SteerInputDeliveryHost::discard_prepared_input(self, chat, client_message_id)
    }

    fn publish_idle(&self, chat: &str) -> ExecutionOperationResult<()> {
        self.owner()?.emit(CoordinatorEvent::ChatIdle(chat))
    }

    fn publish_project_unavailable(
        &self,
        chat: &str,
        error: &DomainError,
    ) -> ExecutionOperationResult<()> {
        self.owner()?
            .emit(CoordinatorEvent::ProjectUnavailable(chat, error))
    }

    fn publish_turn_failed(
        &self,
        chat: &str,
        message: &str,
        options: &RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()> {
        self.owner()?
            .emit(CoordinatorEvent::TurnFailed(chat, message, options))
    }

    fn publish_turn_started(&self, chat: &str, run_id: &str) -> ExecutionOperationResult<()> {
        self.owner()?
            .emit(CoordinatorEvent::TurnStarted(chat, run_id))
    }

    fn retire_attempt(
        &self,
        chat: &str,
        attempt: &Rc<QueueExecutionAttempt>,
    ) -> ExecutionOperationResult<()> {
        let owner = self.owner()?;
        owner.retire_attempt(chat, attempt, None)?;
        owner.ownership.request_drain(chat);
        owner.invalidate_processing(chat)
    }
}

#[async_trait(?Send)]
impl ChatExecutionCommands for ChatExecutionCoordinator {
    async fn delete_chat_queue_file(&self, chat: &str) -> ExecutionOperationResult<()> {
        let owner = self.owned();
        let chat = chat.to_owned();
        self.owned_operation(Box::pin(async move {
            owner
                .locks
                .run_exclusive(
                    &format!("chat:{chat}"),
                    || {
                        let reason: AdmissionAbortReason = Rc::new(Box::new(
                            std::io::Error::other("Turn interrupted because the chat was deleted"),
                        ));
                        owner.ownership.clear_chat(&chat, &reason);
                        owner.queued_steers.forget(&chat);
                        owner.controls.delete_stored(&chat);
                        ready(())
                    },
                    None,
                )
                .await?;
            Ok(())
        }))
        .await
    }

    async fn schedule_direct_input(
        &self,
        input: AcceptedDirectInput,
    ) -> ExecutionOperationResult<DirectInputScheduleOutcome> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.schedule(input).await
        }))
        .await
    }

    async fn run_initial_input(&self, input: AcceptedDirectInput) -> ExecutionOperationResult<()> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.run_initial(input).await
        }))
        .await
    }

    async fn schedule_direct_operation(
        &self,
        input: AcceptedDirectOperation,
    ) -> ExecutionOperationResult<()> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.schedule_operation(input).await
        }))
        .await
    }

    async fn enqueue_accepted(
        &self,
        input: AcceptedQueueCreate,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.enqueue(input).await
        }))
        .await
    }

    async fn replace_accepted(
        &self,
        input: AcceptedQueueReplace,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.replace(input).await
        }))
        .await
    }

    async fn delete_accepted(
        &self,
        input: AcceptedQueueDelete,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        let owner = self.owned();
        self.owned_operation(Box::pin(
            async move { owner.accepted_input.delete(input).await },
        ))
        .await
    }

    async fn move_accepted(
        &self,
        input: AcceptedQueueMove,
    ) -> ExecutionOperationResult<QueueMoveResult> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.move_entry(input).await
        }))
        .await
    }

    async fn capture_steer_target(
        &self,
        chat: &str,
        deadline: f64,
    ) -> ExecutionOperationResult<Option<CapturedSteerTarget>> {
        self.steer_input.capture_target(chat, Some(deadline)).await
    }

    async fn deliver_accepted_steer(
        &self,
        input: AcceptedSteerInput,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome> {
        let owner = self.owned();
        self.owned_operation(Box::pin(
            async move { owner.accepted_input.steer(input).await },
        ))
        .await
    }

    async fn deliver_accepted_queue_entry_steer(
        &self,
        input: AcceptedQueueEntrySteer,
    ) -> ExecutionOperationResult<AcceptedQueueEntrySteerOutcome> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.steer_queue_entry(input).await
        }))
        .await
    }

    async fn enqueue_accepted_steer(
        &self,
        input: AcceptedQueueSteerCreate,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.enqueue_steer(input).await
        }))
        .await
    }

    async fn mark_accepted_queue_entry_steer(
        &self,
        input: AcceptedQueueEntrySteerMark,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        let owner = self.owned();
        self.owned_operation(Box::pin(async move {
            owner.accepted_input.mark_queue_entry_steer(input).await
        }))
        .await
    }

    async fn recover_queue_entry_steer(
        &self,
        chat: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        let owner = self.owned();
        let (chat, entry_id) = (chat.to_owned(), entry_id.to_owned());
        self.owned_operation(Box::pin(async move {
            owner
                .accepted_input
                .recover_queue_entry_steer(&chat, &entry_id)
                .await
        }))
        .await
    }

    async fn stop_active_turn(&self, chat: &str) -> ExecutionOperationResult<StopActiveTurnResult> {
        let owner = self.owned();
        let chat = chat.to_owned();
        self.owned_operation(Box::pin(async move { owner.stop(&chat).await }))
            .await
    }

    async fn interrupt_active_turn(&self, chat: &str) -> ExecutionOperationResult<ChatStopOutcome> {
        let owner = self.owned();
        let chat = chat.to_owned();
        self.owned_operation(Box::pin(async move {
            let result = owner
                .request_stop(&chat, ChatStopIntent::InterruptAndSend)
                .wait()
                .await;
            owner.request_drain(&chat, "interrupt")?;
            result
        }))
        .await
    }

    async fn abort_for_chat_deletion(&self, chat: &str) -> ExecutionOperationResult<bool> {
        self.ownership.enter_deletion_suppression(chat);
        let owner = self.owned();
        let chat = chat.to_owned();
        self.owned_operation(Box::pin(async move {
            let outcome = owner
                .request_stop(&chat, ChatStopIntent::ChatDeletion)
                .wait()
                .await;
            if !outcome
                .as_ref()
                .is_ok_and(|outcome| is_stop_satisfied(*outcome))
            {
                owner.rollback_deletion(&chat)?;
            }
            Ok(is_stop_satisfied(outcome?))
        }))
        .await
    }

    fn rollback_chat_deletion(&self, chat: &str) -> ExecutionOperationResult<()> {
        self.rollback_deletion(chat)
    }

    fn reserve_transcript_snapshot(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<TranscriptSnapshotReservation> {
        self.assert_unowned(chat)?;
        Ok(self.ownership.reserve_transcript_snapshot(chat)?)
    }

    fn replace_turn_with_transcript_snapshot_reservation(
        &self,
        chat: &str,
        turn: &TurnIdentity,
    ) -> Option<TranscriptSnapshotReservation> {
        ChatExecutionCoordinator::replace_turn_with_transcript_snapshot_reservation(
            self, chat, turn,
        )
    }

    async fn release_transcript_snapshot(
        &self,
        reservation: &TranscriptSnapshotReservation,
    ) -> ExecutionOperationResult<()> {
        self.ownership.release_transcript_snapshot(reservation)?;
        let chat = &reservation.chat_id;
        let requested = self.ownership.has_drain_request(chat);
        self.ownership.notify_owners_changed();
        if requested
            && self.options.host.chat_exists(chat)
            && !self.shutting_down.get()
            && let Some(task) = self.prepare_drain(chat)?
        {
            let chat = chat.clone();
            let owner = self.owned();
            tokio::task::spawn_local(async move {
                if let Err(error) = task.await {
                    owner.logger.warn(&format!("Deferred queue drain failed after exclusive operation release ({chat}): {error}"));
                }
            });
        }
        Ok(())
    }

    async fn wait_for_dispatches(&self) -> ExecutionOperationResult<()> {
        ChatExecutionCoordinator::wait_for_dispatches(self).await
    }

    fn owns_execution(&self, chat_id: &str) -> bool {
        ChatExecutionCoordinator::owns_execution(self, chat_id)
    }

    async fn read_chat_execution_control(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionCoordinator::read_chat_execution_control(self, chat).await
    }

    fn with_chat_execution_control<'a, T: 'a>(
        &'a self,
        chat: &'a str,
        operation: impl FnOnce(StoredChatExecutionControlState) -> LocalExecutionFuture<'a, T> + 'a,
    ) -> LocalExecutionFuture<'a, T> {
        Box::pin(self.controls.with_control(chat, operation))
    }

    async fn clear_chat_queue(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.ownership.clear_abort_suppression(chat);
        self.ownership.consume_drain_request(chat);
        let control = self.controls.clear(chat).await?;
        self.request_drain(chat, "queue clear")?;
        Ok(control)
    }

    async fn discard_pending_chat_input(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.controls.discard_pending_input(chat).await
    }

    async fn pause_chat_queue(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        Ok(self.controls.pause(chat).await?.control)
    }

    async fn resume_chat_queue(
        &self,
        chat: &str,
        pause_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        let result = self.controls.resume(chat, pause_id).await?;
        if result.changed {
            self.ownership.clear_abort_suppression(chat);
        }
        Ok(result.control)
    }

    async fn resume_and_drain(
        &self,
        chat: &str,
        pause_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        let control = self.resume_chat_queue(chat, pause_id).await?;
        self.request_drain(chat, "queue resume")?;
        Ok(control)
    }
}

#[async_trait(?Send)]
impl ChatExecutionLifecycle for ChatExecutionCoordinator {
    fn begin_shutdown(&self) -> Vec<String> {
        ChatExecutionCoordinator::begin_shutdown(self)
    }

    async fn abort_for_shutdown(&self, chat: &str) -> ExecutionOperationResult<bool> {
        ChatExecutionCoordinator::abort_for_shutdown(self, chat).await
    }

    async fn wait_for_execution_owners(&self) {
        ChatExecutionCoordinator::wait_for_execution_owners(self).await;
    }

    async fn wait_for_dispatches(&self) -> ExecutionOperationResult<()> {
        ChatExecutionCoordinator::wait_for_dispatches(self).await
    }

    fn get_queued_turn_finalization(
        &self,
        chat: &str,
        turn_id: Option<&str>,
    ) -> Option<QueuedTurnFinalization> {
        ChatExecutionCoordinator::get_queued_turn_finalization(self, chat, turn_id)
    }
}

#[async_trait(?Send)]
impl ChatExecutionQueries for ChatExecutionCoordinator {
    async fn read_chat_execution_control(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        ChatExecutionCoordinator::read_chat_execution_control(self, chat).await
    }

    fn owns_execution(&self, chat_id: &str) -> bool {
        ChatExecutionCoordinator::owns_execution(self, chat_id)
    }

    fn is_chat_turn_reserved(&self, chat: &str) -> bool {
        self.ownership.is_turn_reserved(chat)
    }

    fn get_turn_reserved_chat_ids(&self) -> Vec<String> {
        self.ownership.turn_reserved_chat_ids()
    }

    fn is_chat_stop_in_flight(&self, chat: &str) -> bool {
        self.stop_tasks.borrow().contains_key(chat)
    }
}
