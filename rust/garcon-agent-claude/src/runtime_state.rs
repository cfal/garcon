use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use garcon_contract::chat_modes::{ClaudeThinkingMode, PermissionMode, ThinkingMode};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{
    active_turn::ClaudeActiveTurn,
    cli_process_transport::{ClaudeProcessTransport, Retirement},
    cli_protocol::ClaudeProviderSessionState,
    session_options::{ClaudeSessionOptions, normalize_claude_thinking_mode_for_state},
};

pub const CONVERSATION_RESET_FAILURE: &str = "Claude CLI cleared the conversation mid-turn. The chat transcript is unchanged; send the message again to continue from it.";
pub const INTERRUPT_RECEIPT_TIMEOUT: Duration = Duration::from_secs(5);
pub const INTERRUPT_COMPLETION_TIMEOUT: Duration = Duration::from_secs(15);

pub enum InterruptFallbackStage {
    Receipt,
    Completion,
}

pub struct ClaudeRunningSession {
    pub id: String,
    pub chat_id: String,
    pub initialization: RefCell<Option<CancellationToken>>,
    pub last_activity_at: Cell<Instant>,
    pub provider_state: Cell<ClaudeProviderSessionState>,
    pub background_task_count: Cell<usize>,
    pub unowned_provider_activity: Cell<bool>,
    pub active_turn: RefCell<Option<Rc<ClaudeActiveTurn>>>,
    pub process: RefCell<Option<ClaudeSessionProcess>>,
    pub retirement: RefCell<Option<Rc<Retirement>>>,
    pub options: RefCell<ClaudeSessionOptions>,
    pub current_permission_mode: Cell<PermissionMode>,
    pub current_thinking_mode: Cell<ThinkingMode>,
    pub current_claude_thinking_mode: Cell<ClaudeThinkingMode>,
    pub current_model: RefCell<String>,
    pub current_env_overrides: RefCell<Option<IndexMap<String, String>>>,
}

#[derive(Clone)]
pub struct ClaudeSessionProcess {
    pub identity: Rc<()>,
    pub transport: ClaudeProcessTransport,
}

impl ClaudeRunningSession {
    pub fn new(options: ClaudeSessionOptions) -> Self {
        Self {
            id: options.agent_session_id.clone(),
            chat_id: options.chat_id.clone(),
            initialization: RefCell::new(None),
            last_activity_at: Cell::new(Instant::now()),
            provider_state: Cell::new(ClaudeProviderSessionState::Unknown),
            background_task_count: Cell::new(0),
            unowned_provider_activity: Cell::new(false),
            active_turn: RefCell::new(None),
            process: RefCell::new(None),
            retirement: RefCell::new(None),
            current_permission_mode: Cell::new(options.permission_mode),
            current_thinking_mode: Cell::new(options.thinking_mode),
            current_claude_thinking_mode: Cell::new(normalize_claude_thinking_mode_for_state(
                options.claude_thinking_mode,
            )),
            current_model: RefCell::new(options.model.clone()),
            current_env_overrides: RefCell::new(options.env_overrides.clone()),
            options: RefCell::new(options),
        }
    }

    pub fn process_id(&self) -> Option<u32> {
        self.process
            .borrow()
            .as_ref()
            .and_then(|process| process.transport.pid())
    }

    pub fn is_current_turn(&self, turn: &ClaudeActiveTurn) -> bool {
        self.active_turn
            .borrow()
            .as_deref()
            .is_some_and(|current| std::ptr::eq(current, turn))
    }

    pub fn is_current_process(&self, identity: &Rc<()>) -> bool {
        self.process
            .borrow()
            .as_ref()
            .is_some_and(|process| Rc::ptr_eq(identity, &process.identity))
    }
}

pub struct PendingPermission {
    pub permission_occurrence_id: String,
    pub cli_request_id: String,
    pub agent_session_id: String,
    pub tool_name: String,
    pub tool_input: Opaque,
    pub tool_use_id: Option<String>,
    pub turn: Rc<ClaudeActiveTurn>,
}
