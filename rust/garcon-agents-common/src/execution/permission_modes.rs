//! Ports `server-agents/common/src/execution/permission-modes.ts`.

use garcon_contract::chat_modes::PermissionMode;

pub fn is_manual_bypass_mode(mode: Option<PermissionMode>) -> bool {
    mode == Some(PermissionMode::ManualBypass)
}

pub fn provider_startup_permission_mode(mode: Option<PermissionMode>) -> PermissionMode {
    match mode {
        Some(PermissionMode::ManualBypass) | None => PermissionMode::Default,
        Some(mode) => mode,
    }
}
