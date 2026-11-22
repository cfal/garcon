// Agent HTTP client. Agents own runtime auth, readiness, and catalog state.

import { apiGet, apiPost } from './client.js';
import { effectiveExecutorId } from '$shared/executors';
import type { AgentId } from '$shared/agents';
import type {
	AgentAuthLoginCompleteResult,
	AgentAuthLoginLaunchResult,
	AgentAuthLoginHttpStatus as AgentAuthLoginStatus,
	AgentDeviceAuthInfo,
} from '$shared/agent-auth';
import { LOGIN_INSTANCE_QUERY } from '$shared/agent-auth';
import {
	parseAgentCliUpdatesResponse,
	parseAgentCliUpdateStatus,
	type AgentCliUpdateRequest,
	type AgentCliUpdatesResponse,
	type AgentCliUpdateStatus,
} from '$shared/agent-cli-update';

export type AgentName = AgentId;

export interface AgentAuthStatus {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
	source?: 'oauth' | 'api-key' | 'environment' | 'cli' | 'none' | 'unknown';
	detail?: string;
}

export interface AgentReadiness {
	ready: boolean;
	nativeReady: boolean;
	endpointReady: boolean;
	reason: string;
}

export type DeviceAuthInfo = AgentDeviceAuthInfo;
export type AgentAuthLoginResult = AgentAuthLoginLaunchResult;
export type { AgentAuthLoginStatus };

export async function getAgentAuthStatus(agent: AgentName, executorId?: string, loginInstance?: string): Promise<AgentAuthStatus> {
	const instanceQuery = loginInstance === undefined ? '' : `&${LOGIN_INSTANCE_QUERY}=${encodeURIComponent(loginInstance)}`;
	const result = await apiGet<Record<string, AgentAuthStatus>>(
		`/api/v1/agents/auth?agent=${encodeURIComponent(agent)}&executorId=${encodeURIComponent(effectiveExecutorId(executorId))}${instanceQuery}`,
	);
	return result[agent];
}

export async function getAgentReadiness(executorId?: string): Promise<Record<string, AgentReadiness>> {
	return apiGet<Record<string, AgentReadiness>>(`/api/v1/agents/readiness?executorId=${encodeURIComponent(effectiveExecutorId(executorId))}`);
}

export async function launchAgentAuthLogin(agent: AgentName, executorId?: string): Promise<AgentAuthLoginResult> {
	return apiPost<AgentAuthLoginResult>('/api/v1/agents/auth/login', { agentId: agent, executorId: effectiveExecutorId(executorId) });
}

export async function completeAgentAuthLogin(
	agent: AgentName,
	sessionId: string,
	code: string,
	executorId?: string,
): Promise<AgentAuthLoginCompleteResult> {
	return apiPost<AgentAuthLoginCompleteResult>('/api/v1/agents/auth/login/complete', {
		agentId: agent,
		executorId: effectiveExecutorId(executorId),
		sessionId,
		code,
	});
}

export async function getAgentAuthLoginStatus(
	agent: AgentName,
	expectedSessionId?: string,
	executorId?: string,
): Promise<AgentAuthLoginStatus> {
	const sessionQuery = expectedSessionId ? `&session=${encodeURIComponent(expectedSessionId)}` : '';
	return apiGet<AgentAuthLoginStatus>(
		`/api/v1/agents/auth/login?agent=${encodeURIComponent(agent)}&executorId=${encodeURIComponent(effectiveExecutorId(executorId))}${sessionQuery}`,
	);
}

// Reads every agent's CLI status, or only `agentIds` when given.
export async function getAgentCliUpdates(
	executorId: string,
	options: { readonly refresh: boolean; readonly agentIds?: readonly string[] },
): Promise<AgentCliUpdatesResponse> {
	const query = new URLSearchParams({ executorId: effectiveExecutorId(executorId) });
	if (options.refresh) query.set('refresh', '1');
	for (const agentId of options.agentIds ?? []) query.append('agent', agentId);
	const response = parseAgentCliUpdatesResponse(await apiGet<unknown>(`/api/v1/agents/cli-updates?${query}`));
	if (!response) throw new Error('The server returned an invalid CLI update status.');
	return response;
}

export async function startAgentCliUpdate(agent: AgentName, executorId: string): Promise<AgentCliUpdateStatus> {
	const status = parseAgentCliUpdateStatus(
		await apiPost<unknown>('/api/v1/agents/cli-updates', {
			agentId: agent,
			executorId: effectiveExecutorId(executorId),
		} satisfies AgentCliUpdateRequest),
	);
	if (!status) throw new Error('The server returned an invalid CLI update status.');
	return status;
}
