//! Ports `common/handoff-timeouts.ts`.

pub const AGENT_HANDOFF_HTTP_TIMEOUT_MS: u64 = 33 * 60 * 1_000;
// Zero disables the Bun request idle timer while the client bounds the handoff.
pub const AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS: u64 = 0;
