//! Ports `server-agents/common/src/acp/runtime-session.ts`.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use futures::future::{LocalBoxFuture, Shared};
use garcon_contract::chat_command_contracts::PermissionDecisionPayload;
use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::resources::ExecutorResult;
use garcon_js::clock::{Clock, to_iso_string};
use serde_json::Value;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::execution::runtime_events::AgentRuntimeOperation;

use super::client::AcpClient;
use super::event_converter::AcpRetireReason;
use super::protocol::AcpJsonRpcId;
use super::turn_prompts::AcpTurnPrompts;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RuntimeSessionState {
    Idle,
    Running,
    Failed,
    Aborted,
}

impl RuntimeSessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Aborted => "aborted",
        }
    }
}

pub(super) type SessionRef = Rc<RefCell<AcpAgentRuntimeSession>>;
pub(super) type TurnRef = Rc<RefCell<AcpTurnContext>>;
pub(super) type TurnSettled = Shared<LocalBoxFuture<'static, ()>>;

pub(super) struct PendingPermissionRequest {
    pub permission_occurrence_id: String,
    pub tool_call_id: String,
    pub turn: Weak<RefCell<AcpTurnContext>>,
    pub request_id: AcpJsonRpcId,
    pub response_for_decision: Rc<dyn Fn(&PermissionDecisionPayload) -> Value>,
    pub response_for_cancellation: Rc<dyn Fn(AcpRetireReason) -> Value>,
}

pub(super) struct AcpAgentRuntimeSession {
    pub id: String,
    pub chat_id: String,
    pub project_path: String,
    pub client: Rc<AcpClient>,
    pub state: RuntimeSessionState,
    pub retired: bool,
    pub active_turn: Option<TurnRef>,
    pub source_turn: Option<TurnRef>,
    pub pending_turn: Option<TurnRef>,
    pub config_options: Option<Value>,
    pub models: Option<Value>,
    pub started_at: String,
    pub last_activity_at: i64,
}

pub(super) struct AcpTurnContext {
    pub session: Weak<RefCell<AcpAgentRuntimeSession>>,
    pub operation: AgentRuntimeOperation,
    pub pending_permissions: Vec<Rc<PendingPermissionRequest>>,
    pub detach_source_listeners: Vec<Box<dyn Fn()>>,
    pub permission_mode: PermissionMode,
    pub completed: bool,
    pub aborted: bool,
    pub source_retired: bool,
    pub final_response_text: Option<String>,
    pub reported_failure: bool,
    pub settle: Option<oneshot::Sender<()>>,
    pub settled: TurnSettled,
    pub cancel_timer: Option<JoinHandle<()>>,
    pub prompts: AcpTurnPrompts,
}

pub(super) struct AcpRuntimeSessionIdentity {
    pub id: String,
    pub chat_id: String,
    pub project_path: String,
    pub client: Rc<AcpClient>,
    pub config_options: Option<Value>,
    pub models: Option<Value>,
}

pub(super) fn new_runtime_session(
    identity: AcpRuntimeSessionIdentity,
    clock: &dyn Clock,
) -> ExecutorResult<AcpAgentRuntimeSession> {
    Ok(AcpAgentRuntimeSession {
        id: identity.id,
        chat_id: identity.chat_id,
        project_path: identity.project_path,
        client: identity.client,
        state: RuntimeSessionState::Idle,
        retired: false,
        active_turn: None,
        source_turn: None,
        pending_turn: None,
        config_options: identity.config_options,
        models: identity.models,
        started_at: to_iso_string(clock.now_ms())?,
        last_activity_at: clock.now_ms(),
    })
}
