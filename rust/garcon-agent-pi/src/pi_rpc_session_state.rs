//! Ports `server-agents/pi/src/agents/pi/pi-rpc-session-state.ts`.

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use garcon_agents_common::{
    execution::runtime_events::AgentRuntimeOperation, shared::shared_probe::SharedProbe,
};
use garcon_interface::{producer::AgentFinalResponse, resources::ExecutorResult};
use tokio::sync::oneshot;

use crate::{
    pi_process_lifecycle::PiProcess, pi_rpc_client::PiRpcClient, pi_rpc_protocol::PiThinkingLevel,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PiRpcSessionState {
    Starting,
    Idle,
    Prompting,
    Active,
    Retiring,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PiTurnCompletion {
    Pending,
    Finished,
    Failed,
    Stopped,
    Shutdown,
}

pub(crate) struct PiActiveTurn {
    pub operation: AgentRuntimeOperation,
    pub bound: bool,
    pub stop_requested: bool,
    pub settle_observed: bool,
    pub post_settle_run_observed: bool,
    pub completion: PiTurnCompletion,
    pub failure_message: Option<String>,
    pub final_response: Option<AgentFinalResponse>,
    pub steering_queue: Vec<String>,
    pub follow_up_queue: Vec<String>,
    pub settle: Option<oneshot::Sender<()>>,
}

pub(crate) type Turn = Rc<RefCell<PiActiveTurn>>;
pub(crate) type Session = Rc<RefCell<PiRpcSession>>;

pub(crate) struct PiRpcSession {
    pub generation: u64,
    pub state: PiRpcSessionState,
    pub id: String,
    pub chat_id: String,
    pub native_path: Option<String>,
    pub model: String,
    pub thinking: Option<PiThinkingLevel>,
    pub process: Option<PiProcess>,
    pub client: Option<PiRpcClient>,
    pub turn: Option<Turn>,
    pub native_run_open: bool,
    pub conversation_observed: bool,
    pub delivery_reservations: usize,
    pub pending_finish: bool,
    pub start_time: i64,
    pub last_activity_at: i64,
    pub exit_promise: Option<SharedProbe<()>>,
}

pub(crate) struct CapturedPiSteerTarget {
    pub scope: Weak<()>,
    pub session: Session,
    pub generation: u64,
    pub turn: Turn,
    pub consumed: Cell<bool>,
}

#[derive(Default)]
pub(crate) struct PiRetireOptions {
    pub turn_outcome: Option<PiTurnCompletion>,
    pub failure_message: Option<String>,
}

pub(crate) struct PiPromptDispatch {
    pub accepted: oneshot::Receiver<ExecutorResult<()>>,
    pub settle: oneshot::Receiver<()>,
}
