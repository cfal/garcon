//! Ports `server/remote/transport/limits.ts`.

pub const EXECUTOR_RECONNECT_GRACE_MS: u64 = 3 * 60 * 60 * 1000;

pub const RPC_CALL_LIMIT: usize = 256;
pub const BULK_RPC_CALL_LIMIT: usize = 192;
pub const RPC_INSTALLATION_CALL_LIMIT: usize = 64;
pub const RPC_QUEUE_BYTES: usize = 32 * 1024 * 1024;
pub const RPC_QUEUE_MESSAGES: usize = 4096;
pub const BULK_QUEUE_BYTES: usize = 24 * 1024 * 1024;
pub const BULK_QUEUE_MESSAGES: usize = 3072;
pub const BULK_CONTROL_BYTES: usize = 8 * 1024;
pub const BULK_CONTROL_RESERVE_BYTES: usize = 32 * 1024;
pub const BULK_CONTROL_RESERVE_MESSAGES: usize = 4;
pub const PRIMARY_SMALL_RPC_BYTES: usize = 64 * 1024;
pub const BULK_ACQUIRE_TIMEOUT_MS: u64 = 20_000;
pub const BULK_SETUP_TIMEOUT_MS: u64 = 5_000;
pub const RPC_JOURNAL_BYTES: usize = 64 * 1024 * 1024;
pub const BULK_JOURNAL_BYTES: usize = 48 * 1024 * 1024;
