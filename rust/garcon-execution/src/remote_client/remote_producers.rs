//! Client-side publication, resumption, and launch settlement for the worker relay.

use std::{
    cell::{Cell, RefCell},
    error::Error,
    rc::{Rc, Weak},
    time::Duration,
};

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_base::{
    executor_disconnect::{
        EXECUTOR_DISCONNECTED_BEFORE_START, EXECUTOR_DISCONNECTED_MID_TURN, as_agent_call_error,
    },
    log::Logger,
};
use garcon_interface::{
    errors::{
        AgentCallError, AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode,
    },
    execution_v5::AgentExecutionHandle,
    producer::{
        AgentLaunchOutcome, AgentProducedRow, AgentProducerBindRequest, AgentProducerControlEvent,
        AgentProducerEvent, AgentProducerNotification, AgentProducerNotificationEvent,
        AgentProducers, AgentRunFailureDetail,
    },
    resources::{
        AgentProducerBinding, AgentResourceScope, ExecutorCallOptions, ExecutorResult,
        is_agent_resource_ref,
    },
};
use garcon_js::{
    is_safe_integer,
    json::{Opaque, as_number},
};
use garcon_link::{
    failure_reason::{Failure, failure_reason},
    message_session::SessionError,
    rpc::RpcCallOptions,
    rpc_lane::RpcLane,
    rpc_protocol::{ProducerAcknowledgement, ProducerResumeLaunch, ProducerResumeState},
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use super::{
    listeners::Listeners,
    sessions::{HeldCallOptions, HeldSession, RemoteSessionBacking, RemoteSessions},
    wire::{decode, decode_rows, encode, own_rpc_error, unknown_outcome},
};

const ACK_DELAY: Duration = Duration::from_millis(250);
const UNREADABLE_EVENT: &str = "An event from the executor could not be read, so this turn's outcome is unknown. Native history may contain additional output.";

type ProducerListener = dyn Fn(AgentProducerNotification) -> ExecutorResult<()>;
type LaunchSend =
    dyn Fn(HeldSession) -> LocalBoxFuture<'static, ExecutorResult<AgentExecutionHandle>>;

struct UnsettledLaunch {
    send: RefCell<Option<Rc<LaunchSend>>>,
    settled: CancellationToken,
}

struct ResumeReport {
    state: ProducerResumeState<AgentExecutionHandle>,
    run_ids: Vec<String>,
}

struct Binding {
    reference: AgentProducerBinding,
    backing: RefCell<Rc<RemoteSessionBacking>>,
    received: Cell<u64>,
    acknowledged: Cell<u64>,
    unsettled: RefCell<IndexMap<String, Rc<UnsettledLaunch>>>,
    resume: RefCell<Option<ResumeReport>>,
    gap_reported: Cell<bool>,
}

impl Binding {
    fn forget_launch(&self, run_id: &str) {
        if let Some(launch) = self.unsettled.borrow_mut().shift_remove(run_id) {
            launch.settled.cancel();
        }
    }

    fn forget_launches(&self) {
        for (_, launch) in self.unsettled.take() {
            launch.settled.cancel();
        }
    }
}

pub(super) struct RemoteProducers {
    weak: Weak<Self>,
    integration_id: String,
    sessions: Rc<RemoteSessions>,
    logger: Rc<dyn Logger>,
    bindings: RefCell<IndexMap<String, Rc<Binding>>>,
    failed: RefCell<IndexMap<String, Rc<RemoteSessionBacking>>>,
    listeners: Rc<Listeners<ProducerListener>>,
    ack: RefCell<Option<CancellationToken>>,
}

impl RemoteProducers {
    pub fn new(
        integration_id: String,
        sessions: Rc<RemoteSessions>,
        logger: Rc<dyn Logger>,
    ) -> Rc<Self> {
        Rc::new_cyclic(|weak| Self {
            weak: weak.clone(),
            integration_id,
            sessions,
            logger,
            bindings: RefCell::default(),
            failed: RefCell::default(),
            listeners: Rc::default(),
            ack: RefCell::default(),
        })
    }

    pub fn subscribe(&self, listener: Rc<ProducerListener>) -> Box<dyn Fn()> {
        self.listeners.subscribe(listener)
    }

    pub fn retire(&self) {
        for (_, binding) in self.bindings.take() {
            binding.forget_launches();
        }
        self.failed.borrow_mut().clear();
        if let Some(stop) = self.ack.take() {
            stop.cancel();
        }
    }

    pub fn detach(&self, binding: &AgentProducerBinding) {
        if let Some(state) = self.bindings.borrow_mut().shift_remove(&binding.id) {
            state.forget_launches();
        }
    }

    pub async fn bind(
        &self,
        request: AgentProducerBindRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        let options = HeldCallOptions::from(options);
        let held = self.sessions.acquire(RpcLane::Primary, &options).await?;
        if request.binding.scope != held.backing.scope(&self.integration_id)
            || request.binding.id.is_empty()
        {
            return Err(AgentCallError::with_code(
                AgentDeliveryOutcome::Rejected,
                "Producer scope mismatch",
                AgentIntegrationErrorCode::STALE_RESOURCE,
            )
            .into());
        }
        let payload = encode(&request)?;
        let binding = Rc::new(Binding {
            reference: request.binding,
            backing: RefCell::new(held.backing.clone()),
            received: Cell::new(0),
            acknowledged: Cell::new(0),
            unsettled: RefCell::default(),
            resume: RefCell::default(),
            gap_reported: Cell::new(false),
        });
        self.bindings
            .borrow_mut()
            .insert(binding.reference.id.clone(), binding.clone());
        let result = held
            .backing
            .rpc
            .call(
                &self.integration_id,
                "producers.bind",
                payload,
                held.rpc_options(&options),
            )
            .await
            .map_err(own_rpc_error);
        if result.is_err() && self.is_current(&binding) {
            self.detach(&binding.reference);
        }
        result.map(|_| ())
    }

    pub async fn close(
        &self,
        reference: AgentProducerBinding,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        let holder = self
            .bindings
            .borrow()
            .get(&reference.id)
            .map(|state| state.backing.borrow().clone())
            .or_else(|| self.failed.borrow().get(&reference.id).cloned());
        self.detach(&reference);
        self.failed.borrow_mut().shift_remove(&reference.id);
        let mut closing = launch_options(options);
        closing.instance_id = holder
            .as_ref()
            .map(|holder| holder.info.instance_id.clone());
        let payload = encode(&reference)?;
        if let Some(backing) = holder.filter(|holder| holder.rpc.transport.connected()) {
            let held = HeldSession {
                backing,
                timeout_ms: closing.timeout_ms,
            };
            held.backing
                .rpc
                .call(
                    &self.integration_id,
                    "producers.close",
                    payload,
                    held.rpc_options(&closing),
                )
                .await
                .map_err(own_rpc_error)?;
        } else {
            self.sessions
                .call(&self.integration_id, "producers.close", payload, closing)
                .await?;
        }
        Ok(())
    }

    pub async fn launch(
        &self,
        method: &'static str,
        binding_ref: &AgentProducerBinding,
        run_id: &str,
        input: Opaque,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        let state = self.bindings.borrow().get(&binding_ref.id).cloned();
        let launch = launch_options(options);
        let send: Rc<LaunchSend> = Rc::new({
            let launch = launch.clone();
            let producers = self.weak.clone();
            let state = state.as_ref().map(Rc::downgrade);
            let id = self.integration_id.clone();
            let run_id = run_id.to_owned();
            move |held| {
                let mut call = held.rpc_options(&launch);
                call.on_late_result = Some(Rc::new({
                    let rpc = Rc::downgrade(&held.backing.rpc);
                    let id = id.clone();
                    move |handle| {
                        let rpc = rpc.upgrade();
                        let id = id.clone();
                        Box::pin(async move {
                            if let Some((rpc, handle)) = rpc.zip(handle) {
                                rpc.call(&id, "execution.abort", handle, RpcCallOptions::default())
                                    .await?;
                            }
                            Ok(())
                        })
                    }
                }));
                call.on_late_result_lost = Some(Rc::new({
                    let producers = producers.clone();
                    let state = state.clone();
                    let run_id = run_id.clone();
                    move || {
                        if let Some((producers, state)) = producers
                            .upgrade()
                            .zip(state.as_ref().and_then(Weak::upgrade))
                            && producers.is_current(&state)
                            && !state.unsettled.borrow().contains_key(&run_id)
                        {
                            state.unsettled.borrow_mut().insert(
                                run_id.clone(),
                                Rc::new(UnsettledLaunch {
                                    send: RefCell::new(None),
                                    settled: CancellationToken::new(),
                                }),
                            );
                            producers.cancel_launch(&state, &run_id);
                        }
                    }
                }));
                let result = held.backing.rpc.call(&id, method, input.clone(), call);
                Box::pin(async move {
                    let result = result.await.map_err(own_rpc_error)?;
                    decode(result.as_ref())
                })
            }
        });
        let result = self
            .sessions
            .send(RpcLane::Primary, launch.clone(), |held| send(held))
            .await;
        if let (Err(error), Some(state)) = (&result, state)
            && self.is_current(&state)
            && unknown_outcome(error.as_ref())
            && !launch
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
        {
            let lost = Rc::new(UnsettledLaunch {
                send: RefCell::new(Some(send)),
                settled: CancellationToken::new(),
            });
            state
                .unsettled
                .borrow_mut()
                .insert(run_id.to_owned(), lost.clone());
            if let Some(signal) = launch.signal {
                self.watch_launch_cancel(signal, &state, run_id, &lost);
            }
        }
        result
    }

    fn watch_launch_cancel(
        &self,
        signal: CancellationToken,
        state: &Rc<Binding>,
        run_id: &str,
        lost: &Rc<UnsettledLaunch>,
    ) {
        let producers = self.weak.clone();
        let state = Rc::downgrade(state);
        let run_id = run_id.to_owned();
        let settled = lost.settled.clone();
        let lost = Rc::downgrade(lost);
        tokio::task::spawn_local(async move {
            tokio::select! {
                biased;
                () = settled.cancelled() => {},
                () = signal.cancelled() => {
                    if let Some(((producers, state), lost)) = producers.upgrade().zip(state.upgrade()).zip(lost.upgrade())
                        && is_unsettled(&state, &run_id, &lost)
                    {
                        producers.cancel_launch(&state, &run_id);
                    }
                }
            }
        });
    }

    fn cancel_launch(&self, state: &Binding, run_id: &str) {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Cancel<'a> {
            binding: &'a AgentProducerBinding,
            run_id: &'a str,
        }
        let Ok(request) = encode(Cancel {
            binding: &state.reference,
            run_id,
        }) else {
            return;
        };
        let options = HeldCallOptions {
            timeout_ms: None,
            instance_id: Some(state.backing.borrow().info.instance_id.clone()),
            ..Default::default()
        };
        let id = self.integration_id.clone();
        let sessions = self.sessions.clone();
        // A Stop belongs to the worker that could have admitted this launch.
        tokio::task::spawn_local(async move {
            let _ = sessions
                .call(&id, "producers.cancelLaunch", request, options)
                .await;
        });
    }

    pub async fn resume(&self, backing: &Rc<RemoteSessionBacking>) -> Result<(), SessionError> {
        let suspended: Vec<_> = self
            .bindings
            .borrow()
            .values()
            .filter(|state| !Rc::ptr_eq(backing, &state.backing.borrow()))
            .cloned()
            .collect();
        if suspended.is_empty() {
            return Ok(());
        }
        let lost_run_ids: Vec<_> = suspended
            .iter()
            .map(|state| state.unsettled.borrow().keys().cloned().collect::<Vec<_>>())
            .collect();
        for state in &suspended {
            state.backing.replace(backing.clone());
            state.resume.take();
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ResumeBinding<'a> {
            binding: &'a AgentProducerBinding,
            acknowledged_seq: u64,
        }
        #[derive(Serialize)]
        struct Resume<'a> {
            bindings: Vec<ResumeBinding<'a>>,
        }
        let request = encode(Resume {
            bindings: suspended
                .iter()
                .map(|state| ResumeBinding {
                    binding: &state.reference,
                    acknowledged_seq: state.received.get(),
                })
                .collect(),
        })
        .map_err(Rc::from)?;
        let reply = backing
            .rpc
            .call(
                &self.integration_id,
                "producers.resume",
                request,
                RpcCallOptions::default(),
            )
            .await?;
        let raw = reply
            .as_ref()
            .and_then(|reply| reply["resumed"].as_array())
            .ok_or_else(|| session_error("Invalid producer resume reply"))?;
        let scope = backing.scope(&self.integration_id);
        let mut reports = IndexMap::new();
        let mut unreadable = Vec::new();
        for value in raw {
            if let Some(report) = resume_state(value, &scope) {
                reports.insert(report.binding_id.clone(), report);
            } else {
                let binding = value["bindingId"]
                    .as_str()
                    .filter(|id| suspended.iter().any(|state| state.reference.id == *id));
                if let Some(binding) = binding {
                    unreadable.push(binding);
                }
                self.logger.warn(&format!(
                    "Executor producer resume report could not be read ({}, binding={binding:?})",
                    self.integration_id
                ));
            }
        }
        for (state, run_ids) in suspended.into_iter().zip(lost_run_ids) {
            if !self.is_current(&state) || !Rc::ptr_eq(backing, &state.backing.borrow()) {
                continue;
            }
            if let Some(report) = reports.shift_remove(&state.reference.id) {
                state.resume.replace(Some(ResumeReport {
                    state: report,
                    run_ids,
                }));
                self.settle_lost_launches(&state);
            } else {
                let message = if unreadable.contains(&state.reference.id.as_str()) {
                    UNREADABLE_EVENT
                } else {
                    EXECUTOR_DISCONNECTED_MID_TURN
                };
                self.retire_failed(&state);
                self.emit(&state, publication_failed(message));
            }
        }
        self.schedule_acknowledgement();
        Ok(())
    }

    pub fn receive(
        &self,
        value: Opaque,
        seq: u64,
        backing: &Rc<RemoteSessionBacking>,
    ) -> Result<(), SessionError> {
        let scope = backing.scope(&self.integration_id);
        let raw_binding = &value["binding"];
        if !is_agent_resource_ref(raw_binding, "producer", Some(&scope)) {
            return Err(session_error("Producer event scope mismatch"));
        }
        let binding = raw_binding["id"]
            .as_str()
            .and_then(|id| self.bindings.borrow().get(id).cloned());
        let Some(state) = binding else {
            return Ok(());
        };
        if !Rc::ptr_eq(&state.backing.borrow(), backing) || seq <= state.received.get() {
            return Ok(());
        }
        let gap = seq > state.received.replace(seq) + 1;
        self.schedule_acknowledgement();
        if gap {
            self.report_gap(&state);
        }
        let event = &value["event"];
        let decoded = decode_event(event, &scope).unwrap_or_else(|error| {
            let kind = event["type"].as_str().unwrap_or("unknown");
            let reason = failure_reason(Failure::Error(error.as_ref()));
            self.logger.warn(&format!("Executor producer event could not be decoded ({}, binding={}, seq={seq}, type={kind}): {reason}", self.integration_id, state.reference.id));
            if kind == "rows" { publication_gap() } else { publication_failed(UNREADABLE_EVENT) }
        });
        if matches!(
            decoded,
            AgentProducerNotificationEvent::Control(AgentProducerControlEvent::PublicationGap)
        ) {
            self.report_gap(&state);
        } else {
            state.gap_reported.set(false);
            match &decoded {
                AgentProducerNotificationEvent::Control(
                    AgentProducerControlEvent::PublicationFailed { .. },
                ) => self.retire_failed(&state),
                AgentProducerNotificationEvent::Control(
                    AgentProducerControlEvent::LaunchSettled { run_id, .. },
                )
                | AgentProducerNotificationEvent::Provider(AgentProducerEvent::RunEnded {
                    run_id,
                    ..
                }) => state.forget_launch(run_id),
                _ => {}
            }
            self.emit(&state, decoded);
        }
        if self.is_current(&state) {
            self.settle_lost_launches(&state);
        }
        Ok(())
    }

    fn is_current(&self, state: &Rc<Binding>) -> bool {
        self.bindings
            .borrow()
            .get(&state.reference.id)
            .is_some_and(|current| Rc::ptr_eq(current, state))
    }

    fn retire_failed(&self, state: &Binding) {
        self.detach(&state.reference);
        self.failed
            .borrow_mut()
            .insert(state.reference.id.clone(), state.backing.borrow().clone());
    }

    fn report_gap(&self, state: &Binding) {
        if !state.gap_reported.replace(true) {
            self.emit(state, publication_gap());
        }
    }

    fn settle_lost_launches(&self, state: &Rc<Binding>) {
        if state
            .resume
            .borrow()
            .as_ref()
            .is_none_or(|report| state.received.get() < report.state.replay_through_seq)
        {
            return;
        }
        let Some(report) = state.resume.take() else {
            return;
        };
        for run_id in report.run_ids {
            let lost = state.unsettled.borrow().get(&run_id).cloned();
            let Some(lost) = lost else {
                continue;
            };
            let launch = report
                .state
                .launch
                .as_ref()
                .filter(|launch| launch.run_id == run_id);
            if launch.is_some_and(|launch| launch.handle.is_none()) {
                continue;
            }
            if launch.is_none()
                && !report.state.received_run_ids.contains(&run_id)
                && let Some(send) = lost.send.take()
            {
                self.relaunch(state, run_id, &lost, send.as_ref());
                continue;
            }
            state.forget_launch(&run_id);
            let outcome = launch.and_then(|launch| launch.handle.clone()).map_or_else(
                || {
                    let failure = EXECUTOR_DISCONNECTED_BEFORE_START;
                    AgentLaunchOutcome::Failed {
                        error: AgentRunFailureDetail {
                            code: failure.code.into(),
                            message: Some(failure.message.into()),
                        },
                    }
                },
                |handle| AgentLaunchOutcome::Started { handle },
            );
            self.emit(state, launch_settled(run_id, outcome));
        }
    }

    fn relaunch(
        &self,
        state: &Rc<Binding>,
        run_id: String,
        lost: &Rc<UnsettledLaunch>,
        send: &LaunchSend,
    ) {
        let replacement = HeldSession {
            backing: state.backing.borrow().clone(),
            timeout_ms: None,
        };
        let result = send(replacement);
        let (producers, state, lost) =
            (self.weak.clone(), Rc::downgrade(state), Rc::downgrade(lost));
        tokio::task::spawn_local(async move {
            let outcome = match result.await {
                Ok(handle) => AgentLaunchOutcome::Started { handle },
                Err(error) if unknown_outcome(error.as_ref()) => return,
                Err(error) => AgentLaunchOutcome::Failed {
                    error: failure_detail(error.as_ref()),
                },
            };
            if let Some(((producers, state), lost)) =
                producers.upgrade().zip(state.upgrade()).zip(lost.upgrade())
                && is_unsettled(&state, &run_id, &lost)
            {
                state.forget_launch(&run_id);
                producers.emit(&state, launch_settled(run_id, outcome));
            }
        });
    }

    fn emit(&self, state: &Binding, event: AgentProducerNotificationEvent) {
        let notification = AgentProducerNotification {
            binding: state.reference.clone(),
            event,
        };
        self.listeners.for_each(|listener| {
            if let Err(error) = listener(notification.clone()) {
                let reason = failure_reason(Failure::Error(error.as_ref()));
                self.logger.error(&format!(
                    "Executor producer listener failed ({}, binding={}): {reason}",
                    self.integration_id, state.reference.id
                ));
            }
        });
    }

    fn schedule_acknowledgement(&self) {
        if self.ack.borrow().is_some() {
            return;
        }
        let stop = CancellationToken::new();
        self.ack.replace(Some(stop.clone()));
        let producers = self.weak.clone();
        tokio::task::spawn_local(async move {
            tokio::select! {
                biased;
                () = stop.cancelled() => {},
                () = sleep(ACK_DELAY) => {
                    if let Some(producers) = producers.upgrade() { producers.acknowledge(); }
                }
            }
        });
    }

    fn acknowledge(&self) {
        self.ack.take();
        let mut pending: IndexMap<
            String,
            (Rc<RemoteSessionBacking>, Vec<ProducerAcknowledgement>),
        > = IndexMap::new();
        for state in self.bindings.borrow().values() {
            let seq = state.received.get();
            let backing = state.backing.borrow();
            if seq <= state.acknowledged.get() || !backing.rpc.transport.connected() {
                continue;
            }
            state.acknowledged.set(seq);
            let (_, acks) = pending
                .entry(backing.rpc.transport.id.clone())
                .or_insert_with(|| (backing.clone(), Vec::new()));
            acks.push(ProducerAcknowledgement {
                binding_id: state.reference.id.clone(),
                seq,
            });
        }
        for (_, (backing, acks)) in pending {
            backing.rpc.acknowledge_producers(acks);
        }
    }
}

#[async_trait(?Send)]
impl AgentProducers for RemoteProducers {
    fn scope(&self) -> ExecutorResult<AgentResourceScope> {
        self.sessions.scope(&self.integration_id)
    }

    async fn bind(
        &self,
        request: AgentProducerBindRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        Self::bind(self, request, options).await
    }

    async fn close(
        &self,
        reference: AgentProducerBinding,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        Self::close(self, reference, options).await
    }

    fn detach(&self, reference: AgentProducerBinding) {
        Self::detach(self, &reference);
    }

    fn subscribe(&self, listener: Rc<ProducerListener>) -> Box<dyn Fn()> {
        Self::subscribe(self, listener)
    }
}

fn launch_options(options: Option<ExecutorCallOptions>) -> HeldCallOptions {
    let options = options.unwrap_or_default();
    HeldCallOptions {
        signal: options.signal,
        timeout_ms: options.timeout_ms,
        dispatch_deadline: options.dispatch_deadline,
        instance_id: None,
    }
}

fn is_unsettled(state: &Binding, run_id: &str, expected: &Rc<UnsettledLaunch>) -> bool {
    state
        .unsettled
        .borrow()
        .get(run_id)
        .is_some_and(|lost| Rc::ptr_eq(lost, expected))
}

fn resume_state(
    value: &Value,
    scope: &AgentResourceScope,
) -> Option<ProducerResumeState<AgentExecutionHandle>> {
    let binding_id = value["bindingId"].as_str()?.to_owned();
    let seq =
        as_number(&value["replayThroughSeq"]).filter(|seq| *seq >= 0.0 && is_safe_integer(*seq))?;
    let launch = match value.get("launch")? {
        Value::Null => None,
        launch => {
            let run_id = launch["runId"].as_str()?.to_owned();
            let handle = match launch.get("handle")? {
                Value::Null => None,
                handle if is_agent_resource_ref(handle, "execution", Some(scope)) => {
                    Some(AgentExecutionHandle::deserialize(handle).ok()?)
                }
                _ => return None,
            };
            Some(ProducerResumeLaunch { run_id, handle })
        }
    };
    let received_run_ids = value["receivedRunIds"]
        .as_array()?
        .iter()
        .map(|id| id.as_str().map(str::to_owned))
        .collect::<Option<_>>()?;
    Some(ProducerResumeState {
        binding_id,
        replay_through_seq: seq as u64,
        launch,
        received_run_ids,
    })
}

fn decode_event(
    value: &Value,
    scope: &AgentResourceScope,
) -> ExecutorResult<AgentProducerNotificationEvent> {
    if value["type"] == "rows" {
        let rows = decode_rows(&value["rows"])?
            .into_iter()
            .map(|row| AgentProducedRow {
                message: row.message,
                provider_meta: row.provider_meta,
            })
            .collect();
        return Ok(AgentProducerNotificationEvent::Provider(
            AgentProducerEvent::Rows { rows },
        ));
    }
    if value["type"] == "publication-failed" && !is_failure_detail(&value["error"]) {
        return Err("Invalid producer publication failure".into());
    }
    if value["type"] == "launch-settled" {
        let valid = if value["handle"].is_null() {
            is_failure_detail(&value["error"])
        } else {
            is_agent_resource_ref(&value["handle"], "execution", Some(scope))
        };
        if !value["runId"].is_string() || !valid {
            return Err("Invalid launch outcome".into());
        }
    }
    decode(Some(&Opaque::from_value(value.clone())))
}

fn is_failure_detail(value: &Value) -> bool {
    value["code"].is_string() && value.get("message").is_none_or(Value::is_string)
}

fn failure_detail(error: &(dyn Error + 'static)) -> AgentRunFailureDetail {
    let integration = as_agent_call_error(error)
        .map(|error| &**error)
        .or_else(|| error.downcast_ref::<AgentIntegrationError>());
    let (code, message) = integration.map_or_else(
        || ("PROVIDER_FAILURE", error.to_string()),
        |error| (error.code.as_str(), error.message.clone()),
    );
    AgentRunFailureDetail {
        code: code.into(),
        message: (!message.is_empty()).then_some(message),
    }
}

fn publication_gap() -> AgentProducerNotificationEvent {
    AgentProducerNotificationEvent::Control(AgentProducerControlEvent::PublicationGap)
}

fn publication_failed(message: &str) -> AgentProducerNotificationEvent {
    AgentProducerNotificationEvent::Control(AgentProducerControlEvent::PublicationFailed {
        error: AgentRunFailureDetail {
            code: "OUTCOME_UNKNOWN".into(),
            message: Some(message.into()),
        },
    })
}

fn launch_settled(run_id: String, outcome: AgentLaunchOutcome) -> AgentProducerNotificationEvent {
    AgentProducerNotificationEvent::Control(AgentProducerControlEvent::LaunchSettled {
        run_id,
        outcome,
    })
}

fn session_error(message: &'static str) -> SessionError {
    Rc::from(Box::<dyn Error>::from(message))
}
