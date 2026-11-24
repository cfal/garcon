import type { AgentCliUpdateStatus } from '@garcon/common/agent-cli-update';

export interface AgentCliUpdateStatusRequest {
  // Bypasses cached latest-version lookups, as an explicit check for updates does.
  readonly refresh: boolean;
  readonly signal?: AbortSignal;
}

// Reports and updates the native CLI this integration runs on its executor.
// Running sessions keep their process; sessions started after an update run
// the updated CLI.
export interface AgentCliUpdates {
  status(request: AgentCliUpdateStatusRequest): Promise<AgentCliUpdateStatus>;
  // Starts an update in the background and returns the status with its run.
  // While a run is active this returns that run instead of starting another.
  // Rejects with OPERATION_UNSUPPORTED when the installation cannot be updated
  // in place.
  startUpdate(): Promise<AgentCliUpdateStatus>;
}
