//! Ports `server/remote/transport/rpc.ts`.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::error::Error;
use std::future::Future;
use std::rc::{Rc, Weak};
use std::time::Duration;

use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use garcon_base::domain_error::DomainError;
use garcon_base::event_loop_stalls::ActivityTracker;
use garcon_base::executor_disconnect::{ExecutorSessionLostError, reconnect_timed_out};
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::error_codes::is_error_code;
use garcon_contract::git_error::{GitServiceError, is_git_service_error_code};
use garcon_contract::terminal::{
    TerminalStreamServerPayload, parse_terminal_stream_server_message,
};
use garcon_contract::terminal_error::TerminalError;
use garcon_interface::errors::{
    AgentCallError, AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode,
    is_agent_integration_error_code,
};
use garcon_js::{
    is_safe_integer,
    json::{Opaque, as_number, parse},
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::failure_reason::{
    Failure as ReportFailure, MALFORMED_DATA, failure_reason, is_parse_error,
};
use crate::limits::{BULK_CONTROL_BYTES, RPC_CALL_LIMIT, RPC_INSTALLATION_CALL_LIMIT};
use crate::message_session::SessionError;
use crate::rpc_admission::{RpcAdmission, RpcAdmissionBudgets, RpcAdmissionLease};
use crate::rpc_journal::{JournaledCall, RpcJournalOwner, RpcReplyJournal};
use crate::rpc_lane::{BulkConnectionControl, RpcLane, parse_bulk_control};
use crate::rpc_protocol::{
    AgentProducerFrame, ExecutorRpcRequest, OutstandingCall, OutstandingCallState,
    OutstandingCallStatus, ProducerAckFrame, ProducerAcknowledgement, ReplyAckFrame, RpcContinuity,
    SESSION_INSTALLATION_METHODS, rpc_continuity,
};
use crate::rpc_routing::{assert_rpc_lane, assert_rpc_reply_size, assert_rpc_request_size};
use crate::session_transport::SessionTransport;
use crate::terminal_protocol::{TerminalNotification, parse_terminal_notification};

pub const DEFAULT_RPC_TIMEOUT_MS: u64 = 120_000;
const REPLY_ACK_DELAY_MS: u64 = 250;
const REPLY_ACK_BATCH: usize = 1024;

pub type RpcResult = Result<Option<Opaque>, SessionError>;
pub type RpcReplyGuard = Rc<dyn Fn(usize) -> Result<(), SessionError>>;
pub type GuardRpcReply = Rc<dyn Fn(RpcReplyGuard)>;
pub type ObserveUndeliveredReply = Rc<dyn Fn(Rc<dyn Fn()>)>;
pub type RpcHandler = Rc<
    dyn Fn(
        Rc<ExecutorRpcRequest>,
        CancellationToken,
        GuardRpcReply,
        ObserveUndeliveredReply,
    ) -> LocalBoxFuture<'static, RpcResult>,
>;
pub type LateResultHandler =
    Rc<dyn Fn(Option<Opaque>) -> LocalBoxFuture<'static, Result<(), SessionError>>>;
pub type ProducerHandler = Rc<dyn Fn(AgentProducerFrame) -> Result<(), SessionError>>;
pub type ProducerAckHandler = Rc<dyn Fn(Vec<ProducerAcknowledgement>) -> Result<(), SessionError>>;
pub type TerminalHandler = Rc<dyn Fn(TerminalNotification) -> Result<(), SessionError>>;
pub type TerminalDetachHandler =
    Rc<dyn Fn(Opaque) -> LocalBoxFuture<'static, Result<(), SessionError>>>;
pub type BulkControlHandler = Rc<dyn Fn(BulkConnectionControl) -> Result<(), SessionError>>;

#[derive(Clone, Copy, Default)]
pub enum RpcTimeout {
    #[default]
    Default,
    None,
    Milliseconds(u64),
}

#[derive(Default)]
pub struct RpcCallOptions {
    pub timeout: RpcTimeout,
    pub signal: Option<CancellationToken>,
    pub dispatch_deadline: Option<Instant>,
    pub on_late_result: Option<LateResultHandler>,
    pub on_late_result_lost: Option<Rc<dyn Fn()>>,
}

#[derive(Default)]
pub struct ExecutorRpcContinuity {
    pub parked: Option<Rc<ParkedRpcCalls>>,
    pub journal: Option<Rc<RpcReplyJournal>>,
    pub admission: Option<Rc<RpcAdmissionBudgets>>,
    pub recovering: bool,
    pub activity: Option<Rc<ActivityTracker>>,
    pub new_id: Option<Rc<dyn Fn() -> String>>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct ProtocolError(&'static str);

#[derive(Clone, Serialize)]
struct Failure {
    #[serde(skip_serializing_if = "Option::is_none")]
    domain: Option<&'static str>,
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Opaque>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'static str>,
}

fn encode_failure(error: &(dyn Error + 'static)) -> Failure {
    let failure = |domain, code, message: String, status, retryable| Failure {
        domain,
        code,
        message,
        status,
        retryable,
        details: None,
        outcome: None,
    };
    if let Some(error) = error.downcast_ref::<GitServiceError>() {
        return failure(
            Some("git"),
            error.code.as_str(),
            error.message.clone(),
            Some(error.status),
            false,
        );
    }
    if let Some(error) = error.downcast_ref::<TerminalError>() {
        return failure(
            Some("terminal"),
            error.code.as_str(),
            error.message.clone(),
            Some(error.status),
            error.status >= 500,
        );
    }
    if let Some(error) = error.downcast_ref::<DomainError>() {
        return failure(
            Some("executor"),
            error.code.as_str(),
            error.message.clone(),
            Some(error.status),
            error.retryable,
        );
    }
    let call = error.downcast_ref::<AgentCallError>();
    let lost = error.downcast_ref::<ExecutorSessionLostError>();
    let call = call.or(lost.map(|lost| &**lost));
    if let Some(agent) = call
        .map(|call| &**call)
        .or(error.downcast_ref::<AgentIntegrationError>())
    {
        return Failure {
            details: agent.details.clone(),
            outcome: call.map(|call| call.outcome.as_str()),
            ..failure(
                None,
                agent.code.as_str(),
                agent.message.clone(),
                None,
                agent.retryable,
            )
        };
    }
    let message = if is_parse_error(error) {
        MALFORMED_DATA.to_owned()
    } else {
        error.to_string()
    };
    failure(None, "PROVIDER_FAILURE", message, None, false)
}

fn decode_failure(value: &Value) -> Result<SessionError, SessionError> {
    let invalid = || protocol_error("Invalid RPC error");
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let code = value
        .get("code")
        .filter(|code| code.is_string())
        .ok_or_else(invalid)?;
    let retryable = value
        .get("retryable")
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;
    let outcome = value
        .get("outcome")
        .map(|outcome| match outcome.as_str() {
            Some("unknown") => Ok(AgentDeliveryOutcome::Unknown),
            Some("not-dispatched") => Ok(AgentDeliveryOutcome::NotDispatched),
            Some("rejected") => Ok(AgentDeliveryOutcome::Rejected),
            _ => Err(invalid()),
        })
        .transpose()?;
    let status = || {
        value
            .get("status")
            .and_then(as_number)
            .filter(|status| status.fract() == 0.0 && (400.0..=599.0).contains(status))
            .map(|status| status as u16)
    };
    match value.get("domain").and_then(Value::as_str) {
        Some("executor") => {
            let invalid = || protocol_error("Invalid executor RPC error");
            Ok(Rc::new(DomainError::new(
                is_error_code(code).ok_or_else(invalid)?,
                message,
                status().ok_or_else(invalid)?,
                retryable,
            )))
        }
        Some("git") => {
            let code = is_git_service_error_code(code)
                .ok_or_else(|| protocol_error("Invalid Git RPC error"))?;
            Ok(Rc::new(GitServiceError::new(code, message)))
        }
        Some("terminal") => {
            let invalid = || protocol_error("Invalid terminal RPC error");
            let frame = parse_terminal_stream_server_message(&json!({
                "type": "terminal-error", "code": code, "message": message,
            }))
            .ok_or_else(invalid)?;
            let TerminalStreamServerPayload::TerminalError { code, .. } = frame.payload else {
                return Err(invalid());
            };
            Ok(Rc::new(TerminalError::with_status(
                code,
                message,
                status().ok_or_else(invalid)?,
            )))
        }
        _ if value.get("domain").is_some() => Err(protocol_error("Invalid provider RPC error")),
        _ => {
            let code = is_agent_integration_error_code(code)
                .ok_or_else(|| protocol_error("Invalid provider RPC error"))?;
            if let Some(outcome) = outcome {
                Ok(Rc::new(AgentCallError::with_code(outcome, message, code)))
            } else {
                let details = value.get("details").and_then(Value::as_object).cloned();
                Ok(Rc::new(AgentIntegrationError::new(
                    code, message, retryable, details,
                )))
            }
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ReplyFrame<'a> {
    Result {
        id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Opaque>,
    },
    Error {
        id: &'a str,
        error: Failure,
    },
}

impl<'a> ReplyFrame<'a> {
    fn id(&self) -> &'a str {
        match self {
            Self::Result { id, .. } | Self::Error { id, .. } => id,
        }
    }
}

fn protocol_error(message: &'static str) -> SessionError {
    Rc::new(ProtocolError(message))
}

fn call_error(outcome: AgentDeliveryOutcome, message: &'static str) -> SessionError {
    Rc::new(AgentCallError::new(outcome, message))
}

fn lost(outcome: AgentDeliveryOutcome, message: &'static str) -> SessionError {
    Rc::new(ExecutorSessionLostError::new(outcome, message))
}

fn serialize(frame: impl Serialize) -> Result<String, SessionError> {
    serde_json::to_string(&frame).map_err(|error| Rc::new(error) as SessionError)
}

fn positive_sequence(value: &Value) -> Option<u64> {
    as_number(value)
        .filter(|seq| *seq >= 1.0 && is_safe_integer(*seq))
        .map(|seq| seq as u64)
}

fn undeliverable_reply(id: &str) -> Result<String, SessionError> {
    let error = AgentCallError::new(
        AgentDeliveryOutcome::Unknown,
        "The executor's reply could not be delivered, so the outcome is unknown.",
    );
    serialize(ReplyFrame::Error {
        id,
        error: encode_failure(&error),
    })
}

struct OutgoingCall {
    id: String,
    integration_id: String,
    method: String,
    request: Opaque,
    journaled: bool,
    options: RpcCallOptions,
    parked: Weak<ParkedRpcCalls>,
    rpc: RefCell<Option<Weak<ExecutorRpc>>>,
    location: RefCell<Option<(String, u64)>>,
    result: RefCell<Option<oneshot::Sender<RpcResult>>>,
    admission: RefCell<Option<RpcAdmissionLease>>,
    timer: RefCell<Option<JoinHandle<()>>>,
    expiry: RefCell<Option<JoinHandle<()>>>,
}

impl OutgoingCall {
    fn disarm_expiry(&self) {
        if let Some(expiry) = self.expiry.borrow_mut().take() {
            expiry.abort();
        }
    }

    fn finish(&self, result: RpcResult) {
        self.cleanup();
        self.settle(result);
    }

    fn cleanup(&self) {
        if let Some(timer) = self.timer.borrow_mut().take() {
            timer.abort();
        }
        self.disarm_expiry();
        if let Some(lease) = self.admission.borrow_mut().take() {
            lease.release();
        }
    }

    fn settle(&self, result: RpcResult) {
        if let Some(sender) = self.result.borrow_mut().take() {
            let _ = sender.send(result);
        }
    }

    fn arm(self: &Rc<Self>, timeout: Option<u64>) {
        let deadline = timeout.map(|timeout| Instant::now() + Duration::from_millis(timeout));
        let signal = self.options.signal.clone();
        if deadline.is_none() && signal.is_none() {
            return;
        }
        let call = Rc::downgrade(self);
        *self.timer.borrow_mut() = Some(spawn_local(async move {
            let message = tokio::select! {
                biased;
                _ = async {
                    match deadline {
                        Some(deadline) => sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                } => "The executor did not reply in time.",
                _ = async {
                    match signal {
                        Some(signal) => signal.cancelled().await,
                        None => std::future::pending().await,
                    }
                } => "The request was cancelled after it was sent to the executor.",
            };
            if let Some(call) = call.upgrade() {
                call.cancel(message);
            }
        }));
    }

    fn expire(self: &Rc<Self>) {
        self.cancel("The executor did not reconnect in time, so the outcome is unknown.");
    }

    fn cancel(self: &Rc<Self>, message: &'static str) {
        let holder = self.rpc.borrow().as_ref().and_then(Weak::upgrade);
        if let Some(holder) = &holder {
            if !holder.remove_pending(self) {
                return;
            }
            if let Some(receive) = &self.options.on_late_result {
                holder.state.borrow_mut().late_results.insert(
                    self.id.clone(),
                    LateResult {
                        admission: self.admission.borrow_mut().take(),
                        receive: Rc::clone(receive),
                        lost: self.options.on_late_result_lost.clone(),
                    },
                );
            }
        } else if !self
            .parked
            .upgrade()
            .is_some_and(|parked| parked.release(self))
        {
            return;
        }
        self.finish(Err(call_error(AgentDeliveryOutcome::Unknown, message)));
        if let Some(holder) = holder.filter(|holder| !holder.retired()) {
            let _ = holder
                .transport
                .send(json!({"type": "cancel", "id": self.id}).to_string());
        }
    }
}

#[derive(Default)]
pub struct ParkedRpcCalls {
    pub admission: RpcAdmission,
    calls: RefCell<IndexMap<String, Rc<OutgoingCall>>>,
    closed: Cell<bool>,
}

impl ParkedRpcCalls {
    pub fn size(&self) -> usize {
        self.calls.borrow().len()
    }

    fn park(&self, call: Rc<OutgoingCall>) {
        *call.rpc.borrow_mut() = None;
        self.calls
            .borrow_mut()
            .insert(call.id.clone(), Rc::clone(&call));
        let mut expiry = call.expiry.borrow_mut();
        if let Some(deadline) = call.options.dispatch_deadline
            && expiry.is_none()
        {
            let call = Rc::downgrade(&call);
            *expiry = Some(spawn_local(async move {
                sleep_until(deadline).await;
                if let Some(call) = call.upgrade() {
                    call.expire();
                }
            }));
        }
        drop(expiry);
        if self.closed.get() {
            self.reject_all();
        }
    }

    fn release(&self, call: &OutgoingCall) -> bool {
        call.disarm_expiry();
        self.calls.borrow_mut().shift_remove(&call.id).is_some()
    }

    fn take(&self) -> impl Iterator<Item = Rc<OutgoingCall>> + use<> {
        std::mem::take(&mut *self.calls.borrow_mut()).into_values()
    }

    pub fn close(&self) {
        self.closed.set(true);
        self.reject_all();
    }

    pub fn reject_all(&self) {
        for call in self.take() {
            call.finish(Err(call_error(
                AgentDeliveryOutcome::Unknown,
                "The connection to the executor dropped before it replied.",
            )));
        }
    }
}

struct LateResult {
    admission: Option<RpcAdmissionLease>,
    receive: LateResultHandler,
    lost: Option<Rc<dyn Fn()>>,
}

impl LateResult {
    fn release(&self) {
        if let Some(lease) = &self.admission {
            lease.release();
        }
    }
}

struct IncomingCall {
    signal: CancellationToken,
    continuity: RpcContinuity,
}

struct State {
    pending: IndexMap<String, Rc<OutgoingCall>>,
    late_results: IndexMap<String, LateResult>,
    incoming: IndexMap<String, Rc<IncomingCall>>,
    sent: u64,
    received: u64,
    reply_acks: Vec<String>,
    reply_ack_timer: Option<JoinHandle<()>>,
    handler: Option<RpcHandler>,
    producer: Option<ProducerHandler>,
    producer_ack: Option<ProducerAckHandler>,
    terminal: Option<TerminalHandler>,
    terminal_detach: Option<TerminalDetachHandler>,
    retired: bool,
    incoming_open: bool,
    outgoing_open: bool,
    reconciled: bool,
    sent_reconcile: bool,
    installing: bool,
    incoming_installation: HashSet<(String, String)>,
    outgoing_installation: HashSet<(String, String)>,
    recovery_resends: HashSet<String>,
    bulk_control: Option<BulkControlHandler>,
    reconciliation_complete: Option<Rc<dyn Fn()>>,
}

impl State {
    fn new(recovering: bool) -> Self {
        Self {
            pending: IndexMap::new(),
            late_results: IndexMap::new(),
            incoming: IndexMap::new(),
            sent: 0,
            received: 0,
            reply_acks: Vec::new(),
            reply_ack_timer: None,
            handler: None,
            producer: None,
            producer_ack: None,
            terminal: None,
            terminal_detach: None,
            retired: false,
            incoming_open: !recovering,
            outgoing_open: !recovering,
            reconciled: false,
            sent_reconcile: false,
            installing: true,
            incoming_installation: HashSet::new(),
            outgoing_installation: HashSet::new(),
            recovery_resends: HashSet::new(),
            bulk_control: None,
            reconciliation_complete: None,
        }
    }
}

struct JournalOwner {
    rpc: Weak<ExecutorRpc>,
    lane: RpcLane,
    session: String,
}

impl RpcJournalOwner for JournalOwner {
    fn lane(&self) -> RpcLane {
        self.lane
    }

    fn session(&self) -> &str {
        &self.session
    }

    fn offer(&self, payload: &str) -> bool {
        self.rpc.upgrade().is_some_and(|rpc| {
            !rpc.retired()
                && rpc.transport.channel.can_admit(payload)
                && rpc.transport.send(payload.to_owned()).is_ok()
        })
    }
}

pub struct ExecutorRpc {
    pub transport: Rc<SessionTransport>,
    parked: Option<Rc<ParkedRpcCalls>>,
    journal: Option<Rc<RpcReplyJournal>>,
    journal_owner: Rc<dyn RpcJournalOwner>,
    outgoing_admission: RpcAdmission,
    incoming_admission: RpcAdmission,
    new_id: Rc<dyn Fn() -> String>,
    activity: Option<Rc<ActivityTracker>>,
    log: ScopedLogger,
    unsubscribe: RefCell<Option<Box<dyn Fn()>>>,
    state: RefCell<State>,
}

impl ExecutorRpc {
    pub fn new(transport: Rc<SessionTransport>, continuity: ExecutorRpcContinuity) -> Rc<Self> {
        let outgoing_admission = continuity
            .admission
            .as_ref()
            .map(|budgets| budgets.outgoing.clone())
            .or_else(|| {
                continuity
                    .parked
                    .as_ref()
                    .map(|parked| parked.admission.clone())
            })
            .unwrap_or_default();
        let incoming_admission = continuity
            .admission
            .as_ref()
            .map(|budgets| budgets.incoming.clone())
            .or_else(|| {
                continuity
                    .journal
                    .as_ref()
                    .map(|journal| journal.admission.clone())
            })
            .unwrap_or_default();
        let rpc = Rc::new_cyclic(|rpc| Self {
            journal_owner: Rc::new(JournalOwner {
                rpc: Weak::clone(rpc),
                lane: transport.lane,
                session: transport.id.clone(),
            }),
            transport,
            parked: continuity.parked,
            journal: continuity.journal,
            outgoing_admission,
            incoming_admission,
            new_id: continuity
                .new_id
                .unwrap_or_else(|| Rc::new(|| uuid::Uuid::new_v4().to_string())),
            activity: continuity.activity,
            log: create_logger("executor-rpc"),
            unsubscribe: RefCell::default(),
            state: RefCell::new(State::new(continuity.recovering)),
        });
        let weak = Rc::downgrade(&rpc);
        let unsubscribe = rpc
            .transport
            .on_message(Rc::new(move |body| match weak.upgrade() {
                Some(rpc) => rpc.receive(body),
                None => Ok(()),
            }));
        *rpc.unsubscribe.borrow_mut() = Some(Box::new(unsubscribe));
        let weak = Rc::downgrade(&rpc);
        let _unsubscribe_failure = rpc.transport.on_failure(Rc::new(move |_| {
            if let Some(rpc) = weak.upgrade() {
                rpc.retire_unknown();
            }
        }));
        rpc
    }

    fn retired(&self) -> bool {
        self.state.borrow().retired
    }

    pub fn retire_unknown(&self) {
        let (pending, incoming, late) = {
            let mut state = self.state.borrow_mut();
            if state.retired {
                return;
            }
            state.retired = true;
            state.bulk_control = None;
            state.reconciliation_complete = None;
            state.recovery_resends.clear();
            state.handler = None;
            state.producer = None;
            state.producer_ack = None;
            state.terminal = None;
            state.terminal_detach = None;
            if let Some(timer) = state.reply_ack_timer.take() {
                timer.abort();
            }
            state.reply_acks.clear();
            (
                std::mem::take(&mut state.pending),
                std::mem::take(&mut state.incoming),
                std::mem::take(&mut state.late_results),
            )
        };
        if let Some(unsubscribe) = self.unsubscribe.borrow_mut().take() {
            unsubscribe();
        }
        for call in pending.into_values() {
            if call.journaled
                && let Some(parked) = &self.parked
            {
                parked.park(call);
                continue;
            }
            call.finish(Err(lost(
                AgentDeliveryOutcome::Unknown,
                "The connection to the executor dropped before it replied.",
            )));
        }
        for call in incoming.into_values() {
            if call.continuity == RpcContinuity::Session {
                call.signal.cancel();
            }
        }
        if let Some(journal) = &self.journal {
            journal.owner_lost(&self.journal_owner);
        }
        for late in late.into_values() {
            late.release();
            if let Some(lost) = late.lost {
                lost();
            }
        }
    }

    pub fn handle(&self, handler: RpcHandler) {
        self.state.borrow_mut().handler = Some(handler);
    }

    pub fn reconciled(&self) -> bool {
        self.state.borrow().reconciled
    }

    pub fn active(&self) -> bool {
        let state = self.state.borrow();
        !state.retired && state.outgoing_open && self.transport.connected()
    }

    pub fn on_bulk_control(&self, handler: BulkControlHandler) {
        self.state.borrow_mut().bulk_control = Some(handler);
    }

    pub fn on_reconciled(&self, handler: Rc<dyn Fn()>) {
        self.state.borrow_mut().reconciliation_complete = Some(handler);
    }

    pub fn activate_incoming(&self) {
        let mut state = self.state.borrow_mut();
        state.incoming_open = true;
        state.recovery_resends.clear();
    }

    pub fn activate(&self) {
        self.activate_incoming();
        let mut state = self.state.borrow_mut();
        state.outgoing_open = true;
        state.installing = false;
    }

    pub fn on_producer(&self, handler: ProducerHandler) {
        self.state.borrow_mut().producer = Some(handler);
    }

    pub fn on_terminal(&self, handler: TerminalHandler) {
        self.state.borrow_mut().terminal = Some(handler);
    }

    pub fn publish_terminal(&self, frame: &TerminalNotification) -> bool {
        !self.retired() && serialize(frame).is_ok_and(|wire| self.transport.channel.try_send(wire))
    }

    pub fn publish_terminal_control(&self, frame: &TerminalNotification) {
        if !self.retired()
            && self.transport.connected()
            && let Ok(wire) = serialize(frame)
        {
            let _ = self.transport.send(wire);
        }
    }

    pub fn on_terminal_detach(&self, handler: TerminalDetachHandler) {
        self.state.borrow_mut().terminal_detach = Some(handler);
    }

    pub fn detach_terminal(&self, request: Opaque) -> Result<(), SessionError> {
        if !self.retired() && self.transport.connected() {
            #[derive(Serialize)]
            #[serde(tag = "type", rename = "terminal-detach")]
            struct Detach {
                request: Opaque,
            }
            self.transport.send(serialize(Detach { request })?)?;
        }
        Ok(())
    }

    pub fn offer_producer(&self, payload: String) -> bool {
        !self.retired() && self.transport.channel.offer(payload)
    }

    pub fn on_producer_ack(&self, handler: ProducerAckHandler) {
        self.state.borrow_mut().producer_ack = Some(handler);
    }

    pub fn acknowledge_producers(&self, acknowledgements: Vec<ProducerAcknowledgement>) {
        if !self.retired()
            && self.transport.connected()
            && !acknowledgements.is_empty()
            && let Ok(wire) = serialize(ProducerAckFrame { acknowledgements })
        {
            let _ = self.transport.send(wire);
        }
    }

    pub fn call(
        self: &Rc<Self>,
        integration_id: &str,
        method: &str,
        request: Opaque,
        options: RpcCallOptions,
    ) -> impl Future<Output = RpcResult> + use<> {
        let started = self.start_call(integration_id, method, request, options);
        async move {
            match started {
                Ok(receiver) => receiver.await.unwrap_or_else(|_| {
                    Err(lost(
                        AgentDeliveryOutcome::Unknown,
                        "The connection to the executor dropped before it replied.",
                    ))
                }),
                Err(error) => Err(error),
            }
        }
    }

    fn start_call(
        self: &Rc<Self>,
        integration_id: &str,
        method: &str,
        request: Opaque,
        options: RpcCallOptions,
    ) -> Result<oneshot::Receiver<RpcResult>, SessionError> {
        use AgentDeliveryOutcome::NotDispatched;
        let timeout = match options.timeout {
            RpcTimeout::Default => Some(DEFAULT_RPC_TIMEOUT_MS),
            RpcTimeout::None => None,
            RpcTimeout::Milliseconds(timeout) if (1..=i32::MAX as u64).contains(&timeout) => {
                Some(timeout)
            }
            RpcTimeout::Milliseconds(_) => {
                return Err(call_error(NotDispatched, "Invalid executor deadline"));
            }
        };
        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(call_error(NotDispatched, "Executor is unavailable"));
        }
        if self.retired() || !self.transport.connected() {
            return Err(lost(NotDispatched, "Executor is unavailable"));
        }
        assert_rpc_lane(method, &request, self.transport.lane).map_err(SessionError::from)?;
        {
            let mut state = self.state.borrow_mut();
            if !state.outgoing_open && method != "calls.reconcile" {
                return Err(call_error(
                    NotDispatched,
                    "Executor bulk connection is recovering",
                ));
            }
            if method == "calls.reconcile" {
                if state.sent_reconcile {
                    return Err(call_error(
                        NotDispatched,
                        "Session reconciliation already started",
                    ));
                }
                state.sent_reconcile = true;
            }
        }
        let admission = self.admit_call(Direction::Outgoing, method, integration_id)?;
        let (sender, receiver) = oneshot::channel();
        let call = Rc::new(OutgoingCall {
            id: (self.new_id)(),
            integration_id: integration_id.to_owned(),
            method: method.to_owned(),
            request,
            journaled: self.parked.is_some() && rpc_continuity(method) == RpcContinuity::Journaled,
            options,
            parked: self.parked.as_ref().map_or_else(Weak::new, Rc::downgrade),
            rpc: RefCell::default(),
            location: RefCell::default(),
            result: RefCell::new(Some(sender)),
            admission: RefCell::new(admission),
            timer: RefCell::default(),
            expiry: RefCell::default(),
        });
        call.arm(timeout);
        if let Err(error) = self.dispatch(&call) {
            call.finish(Err(Rc::clone(&error)));
            return Err(error);
        }
        Ok(receiver)
    }

    pub async fn reconcile_parked(self: &Rc<Self>) -> Result<(), SessionError> {
        let calls: Vec<_> = self
            .parked
            .as_ref()
            .map(|parked| parked.take().collect())
            .unwrap_or_default();
        let outstanding: Vec<_> = calls
            .iter()
            .filter_map(|call| {
                call.location
                    .borrow()
                    .as_ref()
                    .map(|(session, seq)| OutstandingCall {
                        id: call.id.clone(),
                        session: session.clone(),
                        seq: *seq,
                    })
            })
            .collect();
        let reconciling = self.call(
            "",
            "calls.reconcile",
            Opaque::from_value(json!({ "calls": outstanding })),
            RpcCallOptions::default(),
        );
        for call in &calls {
            if self.retired() {
                if let Some(parked) = &self.parked {
                    parked.park(Rc::clone(call));
                }
            } else {
                self.adopt(call);
            }
        }
        let reply = reconciling.await?;
        let states = reconciled_states(reply.as_ref().and_then(|reply| reply.get("states")))?;
        for call in calls {
            if !self.is_pending(&call) {
                continue;
            }
            let overdue = call
                .options
                .dispatch_deadline
                .is_some_and(|deadline| Instant::now() >= deadline);
            match states.get(&call.id) {
                Some(OutstandingCallStatus::Pending) if overdue => call.expire(),
                Some(OutstandingCallStatus::Pending) => call.disarm_expiry(),
                Some(OutstandingCallStatus::NotReceived) if overdue => {
                    self.remove_pending(&call);
                    call.finish(Err(Rc::new(reconnect_timed_out())));
                }
                Some(OutstandingCallStatus::NotReceived) => {
                    call.disarm_expiry();
                    if let Err(error) = self.dispatch(&call)
                        && self.remove_pending(&call)
                    {
                        call.finish(Err(error));
                    }
                }
                _ => {
                    self.remove_pending(&call);
                    call.finish(Err(lost(
                        AgentDeliveryOutcome::Unknown,
                        "The executor no longer holds the reply to this request.",
                    )));
                }
            }
        }
        Ok(())
    }

    fn adopt(self: &Rc<Self>, call: &Rc<OutgoingCall>) {
        *call.rpc.borrow_mut() = Some(Rc::downgrade(self));
        self.state
            .borrow_mut()
            .pending
            .insert(call.id.clone(), Rc::clone(call));
    }

    fn is_pending(&self, call: &Rc<OutgoingCall>) -> bool {
        self.state
            .borrow()
            .pending
            .get(&call.id)
            .is_some_and(|current| Rc::ptr_eq(current, call))
    }

    fn remove_pending(&self, call: &Rc<OutgoingCall>) -> bool {
        if !self.is_pending(call) {
            return false;
        }
        self.state.borrow_mut().pending.shift_remove(&call.id);
        true
    }

    fn dispatch(self: &Rc<Self>, call: &Rc<OutgoingCall>) -> Result<(), SessionError> {
        let seq = self.state.borrow().sent + 1;
        let payload = serialize(ExecutorRpcRequest {
            id: call.id.clone(),
            seq,
            integration_id: call.integration_id.clone(),
            method: call.method.clone(),
            request: call.request.clone(),
        })?;
        assert_rpc_request_size(&call.method, self.transport.lane, payload.len())
            .map_err(SessionError::from)?;
        if !self.transport.channel.fits_frame(&payload) {
            return Err(call_error(
                AgentDeliveryOutcome::NotDispatched,
                "The request is too large to send to the executor.",
            ));
        }
        if !self.transport.channel.can_admit(&payload) {
            return Err(Rc::new(AgentCallError::with_code(
                AgentDeliveryOutcome::NotDispatched,
                "The connection to the executor is backed up. Try again shortly.",
                AgentIntegrationErrorCode::EXECUTOR_BUSY,
            )));
        }
        self.state.borrow_mut().sent = seq;
        *call.location.borrow_mut() = Some((self.transport.id.clone(), seq));
        self.adopt(call);
        if self.transport.send(payload).is_err() && self.remove_pending(call) {
            call.finish(Err(lost(
                AgentDeliveryOutcome::Unknown,
                "The connection to the executor dropped while the request was being sent.",
            )));
        }
        Ok(())
    }

    fn admit_call(
        &self,
        direction: Direction,
        method: &str,
        integration_id: &str,
    ) -> Result<Option<RpcAdmissionLease>, SessionError> {
        if method == "calls.reconcile" {
            return Ok(None);
        }
        let mut state = self.state.borrow_mut();
        if state.installing
            && self.transport.lane == RpcLane::Primary
            && SESSION_INSTALLATION_METHODS.contains(&method)
        {
            let seen = match direction {
                Direction::Incoming => &mut state.incoming_installation,
                Direction::Outgoing => &mut state.outgoing_installation,
            };
            if seen.len() < RPC_INSTALLATION_CALL_LIMIT
                && seen.insert((method.to_owned(), integration_id.to_owned()))
            {
                return Ok(None);
            }
        }
        let admission = match direction {
            Direction::Incoming => &self.incoming_admission,
            Direction::Outgoing => &self.outgoing_admission,
        };
        admission
            .acquire(self.transport.lane)
            .map(Some)
            .map_err(|error| Rc::new(*error) as SessionError)
    }

    fn receive(self: &Rc<Self>, payload: &str) -> Result<(), SessionError> {
        if self.retired() {
            return Ok(());
        }
        let frame = parse(payload).map_err(|_| protocol_error("Malformed executor RPC frame"))?;
        let kind = frame
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| protocol_error("Invalid executor RPC frame"))?;
        if kind.starts_with("bulk-") {
            let handler = self.state.borrow().bulk_control.clone();
            let handler = handler
                .filter(|_| {
                    self.transport.lane == RpcLane::Primary && payload.len() <= BULK_CONTROL_BYTES
                })
                .ok_or_else(|| protocol_error("Unexpected bulk connection control"))?;
            let control =
                parse_bulk_control(&frame).map_err(|error| Rc::new(error) as SessionError)?;
            return handler(control);
        }
        if self.transport.lane == RpcLane::Bulk
            && matches!(
                kind,
                "terminal" | "terminal-detach" | "producer" | "producer-ack"
            )
        {
            return Err(protocol_error("Primary notification on the bulk lane"));
        }
        match kind {
            "terminal" => {
                let handler = self.state.borrow().terminal.clone();
                if let Some(handler) = handler {
                    let notification = parse_terminal_notification(&frame)
                        .map_err(|error| Rc::new(error) as SessionError)?;
                    handler(notification)?;
                }
                return Ok(());
            }
            "terminal-detach" => {
                let handler = self.state.borrow().terminal_detach.clone();
                let rpc = Rc::clone(self);
                spawn_local(async move {
                    if !rpc.retired()
                        && let Some(handler) = handler
                    {
                        let _ = handler(opaque_field(&frame, "request")).await;
                    }
                });
                return Ok(());
            }
            "producer" => {
                let handler = self
                    .state
                    .borrow()
                    .producer
                    .clone()
                    .ok_or_else(|| protocol_error("Producer receiver is not installed"))?;
                let seq = frame
                    .get("seq")
                    .and_then(positive_sequence)
                    .ok_or_else(|| protocol_error("Invalid producer sequence"))?;
                return handler(AgentProducerFrame {
                    seq,
                    notification: opaque_field(&frame, "notification"),
                });
            }
            "producer-ack" => {
                let acknowledgements = parse_producer_ack(&frame)
                    .ok_or_else(|| protocol_error("Invalid producer acknowledgement"))?;
                let handler = self.state.borrow().producer_ack.clone();
                return match handler {
                    Some(handler) => handler(acknowledgements),
                    None => Ok(()),
                };
            }
            "reply-ack" => {
                let invalid = || protocol_error("Invalid reply acknowledgement");
                let ids: Vec<_> = frame
                    .get("ids")
                    .and_then(Value::as_array)
                    .ok_or_else(invalid)?
                    .iter()
                    .map(|id| id.as_str().map(str::to_owned).ok_or_else(invalid))
                    .collect::<Result<_, _>>()?;
                if let Some(journal) = &self.journal {
                    journal.acknowledge(&self.journal_owner, &ids);
                }
                return Ok(());
            }
            _ => {}
        }
        let id = frame
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| protocol_error("RPC request ID is required"))?;
        match kind {
            "result" | "error" => self.receive_reply(id, kind, &frame, payload.len()),
            "cancel" => {
                let incoming = self.state.borrow().incoming.get(id).cloned();
                if let Some(incoming) = incoming {
                    incoming.signal.cancel();
                } else if let Some(journal) = &self.journal {
                    journal.cancel(&self.journal_owner, id);
                }
                Ok(())
            }
            "request" => {
                let invalid = || protocol_error("Invalid executor RPC request");
                let integration_id = frame
                    .get("integrationId")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?;
                let method = frame
                    .get("method")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?;
                let seq = frame
                    .get("seq")
                    .and_then(positive_sequence)
                    .ok_or_else(|| protocol_error("Invalid RPC request sequence"))?;
                self.receive_request(
                    ExecutorRpcRequest {
                        id: id.to_owned(),
                        seq,
                        integration_id: integration_id.to_owned(),
                        method: method.to_owned(),
                        request: opaque_field(&frame, "request"),
                    },
                    payload.len(),
                )
            }
            _ => Err(protocol_error("Invalid executor RPC request")),
        }
    }

    fn receive_reply(
        self: &Rc<Self>,
        id: &str,
        kind: &str,
        frame: &Value,
        bytes: usize,
    ) -> Result<(), SessionError> {
        let call = self.state.borrow().pending.get(id).cloned();
        let Some(call) = call else {
            let late = self.state.borrow_mut().late_results.shift_remove(id);
            if let Some(late) = late {
                late.release();
                if kind == "result" {
                    let result = frame.get("value").cloned().map(Opaque::from_value);
                    let rpc = Rc::clone(self);
                    spawn_local(async move {
                        if rpc.retired() {
                            if let Some(lost) = late.lost {
                                lost();
                            }
                        } else if let Err(error) = (late.receive)(result).await {
                            rpc.log.warn(&format!(
                                "Failed to clean up a cancelled executor call: {}",
                                failure_reason(ReportFailure::Error(error.as_ref()))
                            ));
                        }
                    });
                }
            }
            return Ok(());
        };
        let failure = if kind == "error" {
            Some(decode_failure(&frame["error"])?)
        } else {
            None
        };
        let failure =
            assert_rpc_reply_size(&call.method, &call.request, self.transport.lane, bytes)
                .err()
                .map(SessionError::from)
                .or(failure);
        self.remove_pending(&call);
        call.cleanup();
        if rpc_continuity(&call.method) == RpcContinuity::Journaled {
            self.acknowledge_reply(id.to_owned());
        }
        match failure {
            Some(error) => call.settle(Err(error)),
            None => call.settle(Ok(frame.get("value").cloned().map(Opaque::from_value))),
        }
        Ok(())
    }

    fn receive_request(
        self: &Rc<Self>,
        frame: ExecutorRpcRequest,
        bytes: usize,
    ) -> Result<(), SessionError> {
        let received = {
            let mut state = self.state.borrow_mut();
            state.received = state.received.max(frame.seq);
            state.received
        };
        if let Some(journal) = &self.journal {
            journal
                .received(self.journal_owner.as_ref(), received)
                .map_err(|error| Rc::new(error) as SessionError)?;
        }
        if self.state.borrow().incoming.contains_key(&frame.id)
            || self
                .journal
                .as_ref()
                .is_some_and(|journal| journal.has(&frame.id))
        {
            return Err(protocol_error("Duplicate RPC request ID"));
        }
        if let Err(error) = assert_rpc_lane(&frame.method, &frame.request, self.transport.lane)
            .and_then(|()| assert_rpc_request_size(&frame.method, self.transport.lane, bytes))
        {
            return self.reject_request(&frame.id, error.as_ref());
        }
        if frame.method == "calls.reconcile" {
            return self.reconcile(&frame);
        }
        let continuity = rpc_continuity(&frame.method);
        let allowed = {
            let mut state = self.state.borrow_mut();
            state.incoming_open
                || (state.recovery_resends.remove(&frame.id)
                    && continuity == RpcContinuity::Journaled)
        };
        if !allowed {
            return self.reject_request(
                &frame.id,
                &AgentCallError::new(
                    AgentDeliveryOutcome::NotDispatched,
                    "Executor bulk connection is recovering",
                ),
            );
        }
        let admission =
            match self.admit_call(Direction::Incoming, &frame.method, &frame.integration_id) {
                Ok(admission) => admission,
                Err(error) => return self.reject_request(&frame.id, error.as_ref()),
            };
        let frame = Rc::new(frame);
        if continuity == RpcContinuity::Journaled
            && let Some(journal) = &self.journal
        {
            let call = journal.begin(Rc::clone(&self.journal_owner), frame.id.clone());
            self.run_journaled(frame, call, Rc::clone(journal), admission);
            return Ok(());
        }
        self.run_incoming(frame, continuity, admission);
        Ok(())
    }

    fn reject_request(&self, id: &str, error: &(dyn Error + 'static)) -> Result<(), SessionError> {
        self.reply(
            ReplyFrame::Error {
                id,
                error: encode_failure(error),
            },
            None,
            None,
        )
        .map(|_| ())
    }

    fn run_incoming(
        self: &Rc<Self>,
        frame: Rc<ExecutorRpcRequest>,
        continuity: RpcContinuity,
        admission: Option<RpcAdmissionLease>,
    ) {
        let call = Rc::new(IncomingCall {
            signal: CancellationToken::new(),
            continuity,
        });
        let handler = {
            let mut state = self.state.borrow_mut();
            state.incoming.insert(frame.id.clone(), Rc::clone(&call));
            state.handler.clone()
        };
        let rpc = Rc::clone(self);
        spawn_local(async move {
            let guard: GuardSlot = Rc::default();
            let undelivered: ObserveSlot = Rc::default();
            let current = || rpc.is_current(&frame.id, &call);
            let result = if current() {
                rpc.run_handler(
                    Rc::clone(&frame),
                    call.signal.clone(),
                    handler,
                    &guard,
                    Some(&undelivered),
                )
                .await
            } else {
                Err(call_error(
                    AgentDeliveryOutcome::NotDispatched,
                    "RPC request cancelled before dispatch",
                ))
            };
            if let Err(error) = &result {
                rpc.log_failure(&frame, error.as_ref());
            }
            if current() {
                let guard = result.is_ok().then(|| guard.borrow().clone()).flatten();
                let reply = frame_reply(&frame.id, result);
                if rpc
                    .reply(reply, Some(&frame), guard.as_ref())
                    .is_ok_and(|delivered| !delivered)
                {
                    let observer = undelivered.borrow().clone();
                    if let Some(observer) = observer {
                        observer();
                    }
                }
            }
            if current() {
                rpc.state.borrow_mut().incoming.shift_remove(&frame.id);
            }
            if let Some(admission) = admission {
                admission.release();
            }
        });
    }

    fn is_current(&self, id: &str, call: &Rc<IncomingCall>) -> bool {
        let state = self.state.borrow();
        !state.retired
            && state
                .incoming
                .get(id)
                .is_some_and(|current| Rc::ptr_eq(current, call))
    }

    fn run_journaled(
        self: &Rc<Self>,
        frame: Rc<ExecutorRpcRequest>,
        call: Rc<JournaledCall>,
        journal: Rc<RpcReplyJournal>,
        admission: Option<RpcAdmissionLease>,
    ) {
        let handler = self.state.borrow().handler.clone();
        let rpc = Rc::clone(self);
        spawn_local(async move {
            let guard: GuardSlot = Rc::default();
            let result = rpc
                .run_handler(
                    Rc::clone(&frame),
                    call.signal.clone(),
                    handler,
                    &guard,
                    None,
                )
                .await;
            if let Err(error) = &result {
                rpc.log_failure(&frame, error.as_ref());
            }
            let guard = result.is_ok().then(|| guard.borrow().clone()).flatten();
            let encode =
                rpc.encode_reply(frame_reply(&frame.id, result), Some(&frame), guard.as_ref());
            let reply = match encode {
                Ok(encoded) => Ok(encoded),
                Err(error) => serialize(ReplyFrame::Error {
                    id: &frame.id,
                    error: encode_failure(error.as_ref()),
                })
                .map(Some),
            };
            let placeholder = undeliverable_reply(&frame.id);
            // INFALLIBLE: a reply and its fallback contain only JSON data.
            let placeholder = placeholder.expect("the unknown-outcome reply serializes");
            let reply = reply.ok().flatten().unwrap_or_else(|| placeholder.clone());
            journal.complete(&call, reply, placeholder);
            if let Some(admission) = admission {
                admission.release();
            }
        });
    }

    async fn run_handler(
        &self,
        frame: Rc<ExecutorRpcRequest>,
        signal: CancellationToken,
        handler: Option<RpcHandler>,
        guard: &GuardSlot,
        undelivered: Option<&ObserveSlot>,
    ) -> RpcResult {
        let handler = handler.ok_or_else(|| {
            call_error(
                AgentDeliveryOutcome::NotDispatched,
                "RPC receiver is not installed",
            )
        });
        if signal.is_cancelled() {
            return Err(call_error(
                AgentDeliveryOutcome::NotDispatched,
                "RPC request cancelled before dispatch",
            ));
        }
        let handler = handler?;
        let register_guard: GuardRpcReply = Rc::new({
            let guard = Rc::clone(guard);
            move |new| *guard.borrow_mut() = Some(new)
        });
        let observe: ObserveUndeliveredReply = Rc::new({
            let slot = undelivered.cloned();
            move |listener| {
                if let Some(slot) = &slot {
                    *slot.borrow_mut() = Some(listener);
                }
            }
        });
        if let Some(activity) = &self.activity {
            let label = rpc_activity(&frame.method);
            activity
                .with_activity(&label, async move {
                    handler(frame, signal, register_guard, observe).await
                })
                .await
        } else {
            handler(frame, signal, register_guard, observe).await
        }
    }

    fn reconcile(&self, frame: &ExecutorRpcRequest) -> Result<(), SessionError> {
        let calls = parse_outstanding(frame.request.get("calls"));
        let Some(calls) = calls.filter(|_| !self.reconciled()) else {
            return self.reject_request(
                &frame.id,
                &AgentCallError::new(
                    AgentDeliveryOutcome::Rejected,
                    "Invalid call reconciliation request",
                ),
            );
        };
        let states = match &self.journal {
            Some(journal) => journal
                .reconcile(&self.journal_owner, &calls)
                .map_err(|error| Rc::new(error) as SessionError)?,
            None => calls
                .into_iter()
                .map(|call| OutstandingCallState {
                    id: call.id,
                    state: OutstandingCallStatus::Unknown,
                })
                .collect(),
        };
        {
            let mut state = self.state.borrow_mut();
            if !state.incoming_open {
                state.recovery_resends.extend(
                    states
                        .iter()
                        .filter(|entry| entry.state == OutstandingCallStatus::NotReceived)
                        .map(|entry| entry.id.clone()),
                );
            }
        }
        self.reply(
            ReplyFrame::Result {
                id: &frame.id,
                value: Some(Opaque::from_value(json!({ "states": states }))),
            },
            None,
            None,
        )?;
        let complete = {
            let mut state = self.state.borrow_mut();
            state.reconciled = true;
            state.reconciliation_complete.clone()
        };
        if let Some(complete) = complete {
            complete();
        }
        if let Some(journal) = &self.journal {
            journal.deliver();
        }
        Ok(())
    }

    fn acknowledge_reply(self: &Rc<Self>, id: String) {
        let mut state = self.state.borrow_mut();
        state.reply_acks.push(id);
        if state.reply_acks.len() >= REPLY_ACK_BATCH {
            drop(state);
            self.flush_reply_acks();
        } else if state.reply_ack_timer.is_none() {
            let weak = Rc::downgrade(self);
            let deadline = Instant::now() + Duration::from_millis(REPLY_ACK_DELAY_MS);
            state.reply_ack_timer = Some(spawn_local(async move {
                sleep_until(deadline).await;
                if let Some(rpc) = weak.upgrade() {
                    rpc.flush_reply_acks();
                }
            }));
        }
    }

    fn flush_reply_acks(&self) {
        let ids = {
            let mut state = self.state.borrow_mut();
            if let Some(timer) = state.reply_ack_timer.take() {
                timer.abort();
            }
            std::mem::take(&mut state.reply_acks)
        };
        if !self.retired()
            && self.transport.connected()
            && !ids.is_empty()
            && let Ok(wire) = serialize(ReplyAckFrame { ids })
        {
            let _ = self.transport.send(wire);
        }
    }

    fn encode_reply(
        &self,
        frame: ReplyFrame<'_>,
        call: Option<&ExecutorRpcRequest>,
        guard: Option<&RpcReplyGuard>,
    ) -> Result<Option<String>, SessionError> {
        let id = frame.id();
        let mut payload = serialize(frame)?;
        let check = || {
            if let Some(guard) = guard {
                guard(payload.len())?;
            }
            if let Some(call) = call {
                assert_rpc_reply_size(
                    &call.method,
                    &call.request,
                    self.transport.lane,
                    payload.len(),
                )
                .map_err(SessionError::from)?;
            }
            Ok::<_, SessionError>(())
        };
        if let Err(error) = check() {
            payload = serialize(ReplyFrame::Error {
                id,
                error: encode_failure(error.as_ref()),
            })?;
        }
        Ok(self
            .transport
            .channel
            .fits_frame(&payload)
            .then_some(payload))
    }

    fn reply(
        &self,
        frame: ReplyFrame<'_>,
        call: Option<&ExecutorRpcRequest>,
        guard: Option<&RpcReplyGuard>,
    ) -> Result<bool, SessionError> {
        let id = frame.id();
        if let Some(payload) = self
            .encode_reply(frame, call, guard)?
            .filter(|payload| self.transport.channel.can_admit(payload))
        {
            self.transport.send(payload)?;
            Ok(true)
        } else {
            self.transport.send(undeliverable_reply(id)?)?;
            Ok(false)
        }
    }

    fn log_failure(&self, frame: &ExecutorRpcRequest, error: &(dyn Error + 'static)) {
        if is_parse_error(error) {
            self.log.warn(&format!(
                "Executor call failed on malformed data: {}",
                json!({
                    "callId": frame.id, "integrationId": frame.integration_id, "method": frame.method,
                    "reason": failure_reason(ReportFailure::Error(error)),
                }),
            ));
        }
    }
}

type GuardSlot = Rc<RefCell<Option<RpcReplyGuard>>>;
type ObserveSlot = Rc<RefCell<Option<Rc<dyn Fn()>>>>;

fn frame_reply(id: &str, result: RpcResult) -> ReplyFrame<'_> {
    match result {
        Ok(value) => ReplyFrame::Result { id, value },
        Err(error) => ReplyFrame::Error {
            id,
            error: encode_failure(error.as_ref()),
        },
    }
}

fn opaque_field(value: &Value, key: &str) -> Opaque {
    Opaque::from_value(value.get(key).cloned().unwrap_or(Value::Null))
}

fn parse_producer_ack(frame: &Value) -> Option<Vec<ProducerAcknowledgement>> {
    frame
        .get("acknowledgements")?
        .as_array()?
        .iter()
        .map(|ack| {
            let binding_id = ack.get("bindingId")?.as_str()?.to_owned();
            let seq = ack
                .get("seq")
                .and_then(as_number)
                .filter(|seq| *seq >= 0.0 && is_safe_integer(*seq))? as u64;
            Some(ProducerAcknowledgement { binding_id, seq })
        })
        .collect()
}

fn parse_outstanding(calls: Option<&Value>) -> Option<Vec<OutstandingCall>> {
    calls?
        .as_array()
        .filter(|calls| calls.len() <= RPC_CALL_LIMIT)?
        .iter()
        .map(|call| {
            Some(OutstandingCall {
                id: call.get("id")?.as_str()?.to_owned(),
                session: call.get("session")?.as_str()?.to_owned(),
                seq: positive_sequence(call.get("seq")?)?,
            })
        })
        .collect()
}

fn rpc_activity(method: &str) -> String {
    let valid = method.len() <= 64
        && method
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        && method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.');
    format!("rpc {}", if valid { method } else { "unknown" })
}

enum Direction {
    Incoming,
    Outgoing,
}

fn reconciled_states(
    value: Option<&Value>,
) -> Result<IndexMap<String, OutstandingCallStatus>, SessionError> {
    let invalid = || protocol_error("Invalid call reconciliation reply");
    let values = value.and_then(Value::as_array).ok_or_else(invalid)?;
    values
        .iter()
        .map(|state| {
            let id = state
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            let status = match state.get("state").and_then(Value::as_str) {
                Some("pending") => OutstandingCallStatus::Pending,
                Some("not-received") => OutstandingCallStatus::NotReceived,
                Some("unknown") => OutstandingCallStatus::Unknown,
                _ => return Err(invalid()),
            };
            Ok((id.to_owned(), status))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use crate::message_session::{MessageSessionAttachment, SessionSocket};
    use crate::rpc_journal::RpcReplyJournalOptions;
    use crate::session_transport::SessionTransportOptions;

    use super::*;

    #[derive(Default)]
    struct Peer {
        outgoing: RefCell<Option<Rc<MessageSessionAttachment>>>,
    }

    impl SessionSocket for Peer {
        fn send(&self, payload: String) -> Result<(), SessionError> {
            let outgoing = self.outgoing.borrow().clone();
            if let Some(outgoing) = outgoing {
                spawn_local(async move { outgoing.receive(payload) });
            }
            Ok(())
        }

        fn close(&self) {
            self.outgoing.borrow_mut().take();
        }
    }

    fn pair(
        session: &str,
        lane: RpcLane,
        controller: ExecutorRpcContinuity,
        worker: ExecutorRpcContinuity,
    ) -> (Rc<ExecutorRpc>, Rc<ExecutorRpc>) {
        let transport = || {
            SessionTransport::new(
                session.to_owned(),
                "peer".to_owned(),
                Rc::new(|_| {}),
                SessionTransportOptions {
                    lane,
                    ..SessionTransportOptions::default()
                },
            )
            .unwrap()
        };
        let controller = ExecutorRpc::new(transport(), controller);
        let worker = ExecutorRpc::new(transport(), worker);
        let to_worker = Rc::new(Peer::default());
        let to_controller = Rc::new(Peer::default());
        let controller_endpoint = controller.transport.attach(to_worker.clone()).unwrap();
        let worker_endpoint = worker.transport.attach(to_controller.clone()).unwrap();
        *to_worker.outgoing.borrow_mut() = Some(Rc::new(worker_endpoint));
        *to_controller.outgoing.borrow_mut() = Some(Rc::new(controller_endpoint));
        (controller, worker)
    }

    #[tokio::test]
    async fn journaled_call_reconciles_on_a_replacement_session_without_running_twice() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let parked = Rc::new(ParkedRpcCalls::default());
                let journal = RpcReplyJournal::new(RpcReplyJournalOptions::default());
                let (first, worker) = pair(
                    "first",
                    RpcLane::Primary,
                    ExecutorRpcContinuity {
                        parked: Some(Rc::clone(&parked)),
                        ..ExecutorRpcContinuity::default()
                    },
                    ExecutorRpcContinuity {
                        journal: Some(Rc::clone(&journal)),
                        ..ExecutorRpcContinuity::default()
                    },
                );
                let (entered, running) = oneshot::channel();
                let (release, done) = oneshot::channel();
                let input = Rc::new(RefCell::new(Some((entered, done))));
                worker.handle(Rc::new(move |request, _, _, _| {
                    let (entered, done) = input.borrow_mut().take().expect("only one call runs");
                    Box::pin(async move {
                        entered.send(()).unwrap();
                        done.await.unwrap();
                        Ok(Some(request.request.clone()))
                    })
                }));
                let request = Opaque::from_value(json!({ "value": "synthetic" }));
                let reply = first.call(
                    "",
                    "projects.inspect",
                    request.clone(),
                    RpcCallOptions::default(),
                );
                tokio::time::timeout(Duration::from_secs(2), running)
                    .await
                    .unwrap()
                    .unwrap();
                first.transport.close(None);
                worker.transport.close(None);
                assert_eq!(parked.size(), 1);
                let (second, replacement) = pair(
                    "second",
                    RpcLane::Primary,
                    ExecutorRpcContinuity {
                        parked: Some(Rc::clone(&parked)),
                        ..ExecutorRpcContinuity::default()
                    },
                    ExecutorRpcContinuity {
                        journal: Some(Rc::clone(&journal)),
                        ..ExecutorRpcContinuity::default()
                    },
                );
                replacement.handle(Rc::new(|_, _, _, _| {
                    panic!("the replacement must not execute the call")
                }));
                tokio::time::timeout(Duration::from_secs(2), second.reconcile_parked())
                    .await
                    .unwrap()
                    .unwrap();
                release.send(()).unwrap();
                assert_eq!(
                    tokio::time::timeout(Duration::from_secs(2), reply)
                        .await
                        .unwrap()
                        .unwrap(),
                    Some(request)
                );
                second.transport.close(None);
                replacement.transport.close(None);
                journal.dispose();
            })
            .await;
    }

    #[tokio::test]
    async fn wrong_lane_calls_fail_before_dispatch_and_leave_the_transport_healthy() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (controller, worker) = pair(
                    "bulk",
                    RpcLane::Bulk,
                    ExecutorRpcContinuity::default(),
                    ExecutorRpcContinuity::default(),
                );
                worker.handle(Rc::new(|_, _, _, _| {
                    panic!("a wrong-lane call did not dispatch")
                }));
                let error = controller
                    .call(
                        "",
                        "projects.inspect",
                        Opaque::from_value(Value::Null),
                        RpcCallOptions::default(),
                    )
                    .await
                    .unwrap_err();
                assert_eq!(
                    error.downcast_ref::<AgentCallError>().unwrap().outcome,
                    AgentDeliveryOutcome::NotDispatched
                );
                assert!(controller.transport.connected());
                controller.transport.close(None);
                worker.transport.close(None);
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn no_deadline_remains_cancellable_and_releases_budget_before_late_cleanup() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let admission = Rc::new(RpcAdmissionBudgets::default());
                let (controller, worker) = pair(
                    "session",
                    RpcLane::Primary,
                    ExecutorRpcContinuity {
                        admission: Some(Rc::clone(&admission)),
                        ..ExecutorRpcContinuity::default()
                    },
                    ExecutorRpcContinuity::default(),
                );
                let (entered, running) = oneshot::channel();
                let (release, response) = oneshot::channel();
                let held = RefCell::new(Some((entered, response)));
                worker.handle(Rc::new(move |_, _, _, _| {
                    let (entered, response) = held.borrow_mut().take().unwrap();
                    Box::pin(async move {
                        entered.send(()).unwrap();
                        response.await.unwrap();
                        Ok(Some(Opaque::from_value(json!("late-resource"))))
                    })
                }));
                let (cleaned, cleanup) = oneshot::channel();
                let cleaned = RefCell::new(Some(cleaned));
                let signal = CancellationToken::new();
                let result = controller.call(
                    "",
                    "forking.fork",
                    Opaque::from_value(Value::Null),
                    RpcCallOptions {
                        timeout: RpcTimeout::None,
                        signal: Some(signal.clone()),
                        on_late_result: Some(Rc::new({
                            let admission = Rc::clone(&admission);
                            move |value| {
                                assert_eq!(admission.outgoing.size(), 0);
                                assert_eq!(value.unwrap().as_value(), "late-resource");
                                let cleaned = cleaned.borrow_mut().take().unwrap();
                                Box::pin(async move {
                                    cleaned.send(()).unwrap();
                                    Ok(())
                                })
                            }
                        })),
                        ..RpcCallOptions::default()
                    },
                );
                running.await.unwrap();
                tokio::time::advance(Duration::from_millis(DEFAULT_RPC_TIMEOUT_MS + 1000)).await;
                assert_eq!(admission.outgoing.size(), 1);
                signal.cancel();
                let error = result.await.unwrap_err();
                assert_eq!(
                    error.to_string(),
                    "The request was cancelled after it was sent to the executor."
                );
                assert_eq!(admission.outgoing.size(), 1);
                release.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(2), cleanup)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(controller.transport.connected());
                controller.transport.close(None);
                worker.transport.close(None);
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn parked_calls_stop_waiting_at_the_dispatch_deadline() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let parked = Rc::new(ParkedRpcCalls::default());
                let (controller, worker) = pair(
                    "session",
                    RpcLane::Primary,
                    ExecutorRpcContinuity {
                        parked: Some(Rc::clone(&parked)),
                        ..ExecutorRpcContinuity::default()
                    },
                    ExecutorRpcContinuity::default(),
                );
                let reply = controller.call(
                    "",
                    "projects.inspect",
                    Opaque::from_value(Value::Null),
                    RpcCallOptions {
                        dispatch_deadline: Some(Instant::now() + Duration::from_millis(50)),
                        ..RpcCallOptions::default()
                    },
                );
                controller.transport.close(None);
                worker.transport.close(None);
                assert_eq!(parked.size(), 1);
                tokio::time::advance(Duration::from_millis(51)).await;
                assert_eq!(
                    reply.await.unwrap_err().to_string(),
                    "The executor did not reconnect in time, so the outcome is unknown."
                );
                assert_eq!(parked.size(), 0);
                assert_eq!(parked.admission.size(), 0);
            })
            .await;
    }

    #[test]
    fn failure_frames_keep_domain_errors_and_hide_parse_payloads() {
        let parse_error = parse("SYNTHETIC_SECRET").unwrap_err();
        let failure = encode_failure(&parse_error);
        assert_eq!(failure.message, MALFORMED_DATA);
        let error = decode_failure(&json!({
            "domain": "executor", "code": "CLI_OUTCOME_UNKNOWN", "status": 503,
            "message": "synthetic", "retryable": false,
        }))
        .unwrap();
        assert!(error.downcast_ref::<DomainError>().is_some());
        assert!(
            decode_failure(&json!({
                "domain": "executor", "code": "UNKNOWN_CODE", "status": 503,
                "message": "synthetic", "retryable": false,
            }))
            .is_err()
        );
    }
}
