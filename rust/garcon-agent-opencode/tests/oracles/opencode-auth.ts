// Recorded inputs for `opencode-auth.ts`: its function takes a runtime with
// optional methods, which the oracle builds from JSON.

import { getOpenCodeAuthStatus } from "../../../../server-agents/opencode/src/agents/opencode/opencode-auth.ts";

export function authStatus(state: Record<string, unknown> | null) {
  const runtime = state === null ? null : {
    ...(state.isAvailable === undefined ? {} : { isAvailable: () => state.isAvailable }),
    ...(state.isTemporarilyUnavailable === undefined ? {} : { isTemporarilyUnavailable: () => state.isTemporarilyUnavailable }),
    ...(state.getUnavailableRetryAfterMs === undefined ? {} : { getUnavailableRetryAfterMs: () => state.getUnavailableRetryAfterMs }),
    ...(state.getUnavailableReason === undefined ? {} : { getUnavailableReason: () => state.getUnavailableReason }),
  };
  return getOpenCodeAuthStatus(runtime as never);
}
