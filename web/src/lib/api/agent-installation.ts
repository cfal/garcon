import { apiGet, apiPost } from './client.js';
import { effectiveExecutorId } from '$shared/executors';
import {
	AGENT_CLI_UPDATE_ACQUIRE_TIMEOUT_MS,
	AGENT_CLI_UPDATE_RPC_TIMEOUT_MS,
	type AgentCliInstallationStatus,
	type AgentCliUpdateRequest,
	type AgentCliUpdateResult,
} from '$shared/agent-installation';

export function getAgentInstallationStatus(agentId: string, executorId: string): Promise<AgentCliInstallationStatus> {
	return apiGet<AgentCliInstallationStatus>(
		`/api/v1/agents/installation?agent=${encodeURIComponent(agentId)}&executorId=${encodeURIComponent(effectiveExecutorId(executorId))}`,
	);
}

export function updateAgentInstallation(request: AgentCliUpdateRequest): Promise<AgentCliUpdateResult> {
	return apiPost<AgentCliUpdateResult>('/api/v1/agents/installation/update', {
		...request,
		executorId: effectiveExecutorId(request.executorId),
	}, { timeoutMs: AGENT_CLI_UPDATE_ACQUIRE_TIMEOUT_MS + AGENT_CLI_UPDATE_RPC_TIMEOUT_MS + 15_000 });
}
