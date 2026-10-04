export const AGENT_CLI_UPDATE_TIMEOUT_MS = 90_000;
export const AGENT_CLI_UPDATE_ACQUIRE_TIMEOUT_MS = 15_000;
export const AGENT_CLI_UPDATE_RPC_TIMEOUT_MS = AGENT_CLI_UPDATE_TIMEOUT_MS + 15_000;

export interface AgentCliUpdateRequest {
  readonly agentId: string;
  readonly executorId: string;
  readonly instanceId: string;
}

export interface AgentCliInstallationStatus {
  readonly version: string;
  readonly minimumVersion: string;
  readonly supported: boolean;
}

export interface AgentCliUpdateResult {
  readonly installation: AgentCliInstallationStatus;
  readonly output: string;
}
