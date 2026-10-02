// Both peers retain disconnected producer ownership for the same interval.
export const EXECUTOR_RECONNECT_GRACE_MS = 3 * 60 * 60 * 1000;

// Bulk work leaves capacity for primary controls on each peer.
export const RPC_CALL_LIMIT = 256;
export const BULK_RPC_CALL_LIMIT = 192;
export const RPC_INSTALLATION_CALL_LIMIT = 64;
export const RPC_QUEUE_BYTES = 32 * 1024 * 1024;
export const RPC_QUEUE_MESSAGES = 4096;
export const BULK_QUEUE_BYTES = 24 * 1024 * 1024;
export const BULK_QUEUE_MESSAGES = 3072;
export const BULK_CONTROL_BYTES = 8 * 1024;
export const BULK_CONTROL_RESERVE_BYTES = 32 * 1024;
export const BULK_CONTROL_RESERVE_MESSAGES = 4;
export const PRIMARY_SMALL_RPC_BYTES = 64 * 1024;
export const BULK_ACQUIRE_TIMEOUT_MS = 20_000;
export const BULK_SETUP_TIMEOUT_MS = 5_000;
export const RPC_JOURNAL_BYTES = 64 * 1024 * 1024;
export const BULK_JOURNAL_BYTES = 48 * 1024 * 1024;
