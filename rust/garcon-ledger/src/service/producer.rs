use std::{cell::RefCell, rc::Rc};

use garcon_base::errors::NamedError;
use garcon_contract::{
    chat_types::{AssistantMessage, ChatMessage},
    command_output::CommandWorkingDirectory,
    garcon_commands::extract_garcon_commands,
};
use garcon_interface::producer::{
    AgentFinalResponse, AgentProducerEvent, AgentRunFailureDetail, AgentRunOutcome,
};
use garcon_js::{clock::to_iso_string, trim};
use indexmap::IndexMap;
use serde_json::json;

use crate::{
    contracts::{
        LedgerRow, LedgerRowData, LedgerRowDraft, RunOrigin, RunOutcome, TranscriptViewId,
    },
    errors::{LedgerError, TranscriptSinkClosedError},
    garcon_command_publication::{
        GarconCommandDispatch, canonicalize_garcon_producer_rows, dispatch_garcon_commands,
    },
    garcon_command_request::notice,
    producer_lease::ProducerLease,
    sqlite_operations::LedgerResult,
};

use super::{
    TranscriptCommitEvent, TranscriptCommitWork, TranscriptLedgerService,
    TranscriptLedgerServiceOptions,
    listeners::OrderedListeners,
    permissions::{
        PermissionActionabilityChange, PermissionState, RetiredPermissionControl,
        provider_permission,
    },
};

pub type GarconCommandSink = dyn for<'a> Fn(GarconCommandDispatch<'a>) -> LedgerResult<()>;
pub type LedgerSyncListener<T> = dyn Fn(&T) -> LedgerResult<()>;
pub type SessionCommitListener =
    dyn for<'a> Fn(TranscriptSessionCommitEvent<'a>) -> LedgerResult<()>;
pub type RunAbandonedListener = dyn Fn(Rc<TranscriptRunRef>) -> TranscriptCommitWork;

pub struct TranscriptSessionCommitEvent<'a> {
    pub chat_id: &'a str,
    pub view_id: &'a TranscriptViewId,
    pub row: &'a LedgerRow,
}

#[derive(Debug, Clone)]
pub struct TranscriptRunRef {
    pub chat_id: String,
    pub run_id: String,
}

pub(super) struct ProducerState {
    pub(super) leases: RefCell<IndexMap<String, Rc<ProducerLease>>>,
    pub(super) active_runs: RefCell<IndexMap<String, String>>,
    pub(super) permissions: RefCell<PermissionState>,
    pub(super) retired: Rc<OrderedListeners<LedgerSyncListener<RetiredPermissionControl>>>,
    pub(super) actionability:
        Rc<OrderedListeners<LedgerSyncListener<PermissionActionabilityChange>>>,
    pub(super) session_listeners: Rc<OrderedListeners<SessionCommitListener>>,
    pub(super) run_ended: Rc<OrderedListeners<LedgerSyncListener<TranscriptRunRef>>>,
    pub(super) run_abandoned: Rc<OrderedListeners<RunAbandonedListener>>,
    pub(super) server_instance_id: String,
    pub(super) create_claim_id: Rc<dyn Fn() -> String>,
    create_run_id: Rc<dyn Fn() -> String>,
    command_sink: Rc<GarconCommandSink>,
}

impl ProducerState {
    pub(super) fn new(options: &mut TranscriptLedgerServiceOptions) -> Self {
        let random_id = || uuid::Uuid::new_v4().to_string();
        Self {
            leases: RefCell::default(),
            active_runs: RefCell::default(),
            permissions: RefCell::default(),
            retired: Rc::default(),
            actionability: Rc::default(),
            session_listeners: Rc::default(),
            run_ended: Rc::default(),
            run_abandoned: Rc::default(),
            server_instance_id: options.server_instance_id.take().unwrap_or_else(random_id),
            create_claim_id: options
                .create_claim_id
                .take()
                .unwrap_or_else(|| Rc::new(random_id)),
            create_run_id: options
                .create_run_id
                .take()
                .unwrap_or_else(|| Rc::new(random_id)),
            command_sink: options
                .command_sink
                .take()
                .unwrap_or_else(|| Rc::new(|_: GarconCommandDispatch<'_>| Ok(()))),
        }
    }
}

struct TerminalFact {
    origin: RunOrigin,
    outcome: RunOutcome,
    error: Option<AgentRunFailureDetail>,
    final_response: Option<AgentFinalResponse>,
    working_directory: Option<CommandWorkingDirectory>,
}

impl TerminalFact {
    fn core(outcome: RunOutcome, error: Option<AgentRunFailureDetail>) -> Self {
        Self {
            origin: RunOrigin::Core,
            outcome,
            error,
            final_response: None,
            working_directory: None,
        }
    }
}

impl TranscriptLedgerService {
    pub fn subscribe_session_committed(
        &self,
        listener: Rc<SessionCommitListener>,
    ) -> Box<dyn Fn()> {
        self.producers.session_listeners.subscribe(listener)
    }

    pub fn subscribe_run_ended_committed(
        &self,
        listener: Rc<LedgerSyncListener<TranscriptRunRef>>,
    ) -> Box<dyn Fn()> {
        self.producers.run_ended.subscribe(listener)
    }

    pub fn subscribe_run_abandoned(&self, listener: Rc<RunAbandonedListener>) -> Box<dyn Fn()> {
        self.producers.run_abandoned.subscribe(listener)
    }

    pub fn open_producer(
        self: &Rc<Self>,
        chat_id: &str,
        owner_agent_id: &str,
    ) -> LedgerResult<Rc<ProducerLease>> {
        if owner_agent_id.is_empty() {
            return Err(type_error("Producer owner agent ID is required"));
        }
        let view_id = self
            .store
            .current_view(chat_id)?
            .ok_or_else(|| type_error(format!("Transcript view is not initialized for {chat_id}")))?
            .view_id;
        if self
            .producers
            .leases
            .borrow()
            .get(chat_id)
            .is_some_and(|lease| !lease.closed())
        {
            return Err(type_error(format!(
                "Transcript producer sink is already open for {chat_id}"
            )));
        }
        let owner = owner_agent_id.to_owned();
        let chat = chat_id.to_owned();
        let closing_chat = chat.clone();
        let weak = Rc::downgrade(self);
        let closing_service = weak.clone();
        let lease = ProducerLease::new(
            move |lease, event| {
                let service = weak.upgrade().ok_or(TranscriptSinkClosedError)?;
                if !service.current_producer(&chat, lease) {
                    return Err(TranscriptSinkClosedError.into());
                }
                match service.publish(&chat, &view_id, &owner, event) {
                    Err(error) if is_fenced(error.as_ref()) => {
                        if let Some(run_id) = service.active_run_id(&chat) {
                            service.abandon_run(&chat, &run_id)?;
                        }
                        Err(error)
                    }
                    result => result,
                }
            },
            move |lease| {
                if let Some(service) = closing_service.upgrade() {
                    if service.current_producer(&closing_chat, lease) {
                        service
                            .producers
                            .leases
                            .borrow_mut()
                            .shift_remove(&closing_chat);
                    }
                    service
                        .producers
                        .active_runs
                        .borrow_mut()
                        .shift_remove(&closing_chat);
                    service
                        .producers
                        .permissions
                        .borrow_mut()
                        .clear_chat(&closing_chat);
                }
                Ok(())
            },
        );
        self.producers
            .leases
            .borrow_mut()
            .insert(chat_id.into(), lease.clone());
        Ok(lease)
    }

    pub fn close_producer(&self, chat_id: &str) -> LedgerResult<()> {
        let lease = self.producers.leases.borrow().get(chat_id).cloned();
        lease.map_or(Ok(()), |lease| lease.close())
    }

    pub fn begin_run(&self, chat_id: &str, run_id: Option<&str>) -> LedgerResult<String> {
        let run_id = run_id.map_or_else(|| (self.producers.create_run_id)(), str::to_owned);
        if run_id.is_empty() {
            return Err(type_error("Run ID is required"));
        }
        if !self.producers.leases.borrow().contains_key(chat_id) {
            return Err(TranscriptSinkClosedError.into());
        }
        let mut active = self.producers.active_runs.borrow_mut();
        if active.contains_key(chat_id) {
            return Err(type_error(format!(
                "Transcript run is already active for {chat_id}"
            )));
        }
        self.producers.permissions.borrow_mut().clear_chat(chat_id);
        active.insert(chat_id.into(), run_id.clone());
        Ok(run_id)
    }

    pub fn active_run_id(&self, chat_id: &str) -> Option<String> {
        self.producers.active_runs.borrow().get(chat_id).cloned()
    }

    pub fn is_run_active(&self, chat_id: &str, expected_run: Option<&str>) -> bool {
        self.producers
            .active_runs
            .borrow()
            .get(chat_id)
            .is_some_and(|run_id| expected_run.is_none_or(|expected| expected == run_id))
    }

    pub fn active_chat_ids(&self) -> Vec<String> {
        self.producers
            .active_runs
            .borrow()
            .keys()
            .cloned()
            .collect()
    }

    pub fn interrupt_run(&self, chat_id: &str) -> LedgerResult<Option<LedgerRow>> {
        let run_id = self
            .producers
            .active_runs
            .borrow_mut()
            .shift_remove(chat_id);
        run_id
            .map(|run_id| {
                self.append_run_end(
                    chat_id,
                    &run_id,
                    TerminalFact::core(RunOutcome::Interrupted, None),
                )
            })
            .transpose()
    }

    pub fn fail_run(
        &self,
        chat_id: &str,
        run_id: &str,
        error: Option<AgentRunFailureDetail>,
    ) -> LedgerResult<Option<LedgerRow>> {
        if !self.is_run_active(chat_id, Some(run_id)) {
            return Ok(None);
        }
        self.producers
            .active_runs
            .borrow_mut()
            .shift_remove(chat_id);
        self.append_run_end(
            chat_id,
            run_id,
            TerminalFact::core(RunOutcome::Failed, error),
        )
        .map(Some)
    }

    fn current_producer(&self, chat_id: &str, lease: &ProducerLease) -> bool {
        self.producers
            .leases
            .borrow()
            .get(chat_id)
            .is_some_and(|current| std::ptr::eq(current.as_ref(), lease))
    }

    fn publish(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        owner_agent_id: &str,
        event: AgentProducerEvent,
    ) -> LedgerResult<()> {
        let commit = match event {
            AgentProducerEvent::Rows { rows } => {
                let publication = canonicalize_garcon_producer_rows(rows)?;
                let rows = self.store.append(chat_id, view_id, &publication.drafts)?;
                let run = self.active_run_id(chat_id);
                dispatch_garcon_commands(
                    &publication,
                    chat_id,
                    view_id,
                    run.as_deref(),
                    &rows,
                    |command| (self.producers.command_sink)(command),
                )?;
                if rows.is_empty() {
                    return Ok(());
                }
                TranscriptCommitEvent::Rows {
                    chat_id: chat_id.into(),
                    view_id: view_id.clone(),
                    rows,
                }
            }
            AgentProducerEvent::Notice {
                run_id,
                content,
                title,
            } => {
                if !self.is_run_active(chat_id, Some(&run_id)) || trim(&content).is_empty() {
                    return Ok(());
                }
                let at = to_iso_string(self.clock.now_ms())?;
                let detail = title.map_or_else(|| json!({}), |title| json!({"title": title}));
                let rows = self
                    .store
                    .append(chat_id, view_id, &[notice(&at, content, detail)])?;
                TranscriptCommitEvent::Rows {
                    chat_id: chat_id.into(),
                    view_id: view_id.clone(),
                    rows,
                }
            }
            AgentProducerEvent::Session { session } => {
                if session
                    .native_session
                    .as_ref()
                    .is_some_and(|native| native.owner_id != owner_agent_id)
                {
                    return Err(type_error(format!(
                        "Native session owner mismatch for {chat_id}"
                    )));
                }
                let row =
                    self.append_one(chat_id, view_id, LedgerRowData::Session { detail: session })?;
                for listener in self.producers.session_listeners.iter() {
                    if let Err(error) = listener(TranscriptSessionCommitEvent {
                        chat_id,
                        view_id,
                        row: &row,
                    }) {
                        self.notifications.report_error(error);
                    }
                }
                TranscriptCommitEvent::Session {
                    chat_id: chat_id.into(),
                    view_id: view_id.clone(),
                    row: Box::new(row),
                }
            }
            AgentProducerEvent::Permission { run_id, permission } => {
                let (data, change) = provider_permission(permission)?;
                let row = self.append_one(chat_id, view_id, data)?;
                let active_run = self.active_run_id(chat_id);
                let run_id = self.producers.permissions.borrow_mut().apply(
                    chat_id,
                    view_id,
                    &run_id,
                    active_run.as_deref(),
                    change,
                );
                TranscriptCommitEvent::Permission {
                    chat_id: chat_id.into(),
                    view_id: view_id.clone(),
                    run_id,
                    row: Box::new(row),
                }
            }
            AgentProducerEvent::RunEnded {
                run_id,
                outcome,
                working_directory,
            } => {
                if !self.is_run_active(chat_id, Some(&run_id)) {
                    return Ok(());
                }
                self.producers
                    .active_runs
                    .borrow_mut()
                    .shift_remove(chat_id);
                let (outcome, error, final_response) = match outcome {
                    AgentRunOutcome::Finished { final_response } => (
                        RunOutcome::Finished,
                        None,
                        final_response.map(project_final_response),
                    ),
                    AgentRunOutcome::Failed { error } => (RunOutcome::Failed, error, None),
                    AgentRunOutcome::Interrupted => (RunOutcome::Interrupted, None, None),
                };
                self.append_run_end(
                    chat_id,
                    &run_id,
                    TerminalFact {
                        origin: RunOrigin::Provider,
                        outcome,
                        error,
                        final_response,
                        working_directory,
                    },
                )?;
                return Ok(());
            }
        };
        self.notifications.notify(commit);
        Ok(())
    }

    pub(super) fn append_one(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        data: LedgerRowData,
    ) -> LedgerResult<LedgerRow> {
        let draft = LedgerRowDraft {
            at: to_iso_string(self.clock.now_ms())?,
            provider_meta: None,
            data,
        };
        self.store
            .append(chat_id, view_id, &[draft])?
            .pop()
            .ok_or_else(|| LedgerError::Ledger("Committed transcript row is missing".into()).into())
    }

    fn append_run_end(
        &self,
        chat_id: &str,
        run_id: &str,
        fact: TerminalFact,
    ) -> LedgerResult<LedgerRow> {
        let commit = || -> LedgerResult<_> {
            let view_id = self
                .store
                .current_view(chat_id)?
                .ok_or_else(|| {
                    type_error(format!("Transcript view is not initialized for {chat_id}"))
                })?
                .view_id;
            let row = self.append_one(
                chat_id,
                &view_id,
                LedgerRowData::RunEnded {
                    origin: fact.origin,
                    outcome: fact.outcome,
                    error: fact.error,
                },
            )?;
            Ok((view_id, row))
        };
        let (view_id, row) = match commit() {
            Ok(result) => result,
            Err(failure) => {
                if is_fenced(failure.as_ref()) {
                    self.abandon_run(chat_id, run_id)?;
                }
                return Err(failure);
            }
        };
        self.producers
            .permissions
            .borrow_mut()
            .clear_run(chat_id, run_id);
        let run = TranscriptRunRef {
            chat_id: chat_id.into(),
            run_id: run_id.into(),
        };
        for listener in self.producers.run_ended.iter() {
            listener(&run)?;
        }
        self.notifications.notify(TranscriptCommitEvent::RunEnded {
            chat_id: run.chat_id,
            view_id,
            run_id: run.run_id,
            row: Box::new(row.clone()),
            final_response: fact.final_response,
            working_directory: fact.working_directory,
        });
        Ok(row)
    }

    fn abandon_run(&self, chat_id: &str, run_id: &str) -> LedgerResult<()> {
        let controls = self
            .producers
            .permissions
            .borrow()
            .controls_for_run(chat_id, run_id);
        self.producers
            .active_runs
            .borrow_mut()
            .shift_remove(chat_id);
        self.close_producer(chat_id)?;
        let retired = self.producers.retired.clone();
        let listeners = self.producers.run_abandoned.clone();
        let notifications = self.notifications.clone();
        let run = Rc::new(TranscriptRunRef {
            chat_id: chat_id.into(),
            run_id: run_id.into(),
        });
        // Prior commits reach their fanout before storage-failure lifecycle state.
        tokio::task::spawn_local(async move {
            for control in &controls {
                for listener in retired.iter() {
                    if let Err(error) = listener(control) {
                        notifications.report_error(error);
                    }
                }
            }
            for listener in listeners.iter() {
                notifications.finish_work(listener(run.clone()));
            }
        });
        Ok(())
    }
}

fn type_error(message: impl Into<String>) -> Box<dyn std::error::Error> {
    NamedError {
        name: "TypeError".into(),
        message: message.into(),
        code: None,
    }
    .into()
}

fn is_fenced(error: &(dyn std::error::Error + 'static)) -> bool {
    matches!(error.downcast_ref(), Some(LedgerError::Fenced { .. }))
}

fn project_final_response(response: AgentFinalResponse) -> AgentFinalResponse {
    match response {
        AgentFinalResponse::LiteralText { .. } => response,
        AgentFinalResponse::Text { text } => {
            let message = ChatMessage::Assistant(AssistantMessage {
                timestamp: String::new(),
                content: text,
                questions: None,
            });
            if let Some(projected) = extract_garcon_commands(&message) {
                return AgentFinalResponse::Text {
                    text: projected
                        .message
                        .map_or_else(String::new, |message| message.content),
                };
            }
            // INFALLIBLE: the message was just assembled as an assistant message.
            let ChatMessage::Assistant(message) = message else {
                unreachable!()
            };
            AgentFinalResponse::Text {
                text: message.content,
            }
        }
    }
}
