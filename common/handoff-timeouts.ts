// Covers two compaction attempts plus request and retry overhead.
export const AGENT_HANDOFF_HTTP_TIMEOUT_MS = 33 * 60 * 1_000;

// Bun clamps positive per-request idle timeouts to 255 seconds. Zero disables
// the idle timer while the client timeout bounds the handoff request.
export const AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS = 0;
