// Agent HTTP client. Agents own runtime auth, readiness, and catalog state.

import { apiGet, apiPost } from './client.js';
import type { AgentCatalog, AgentId } from '$shared/agents';
import type {
	AgentAuthLoginCompleteResult,
	AgentAuthLoginLaunchResult,
	AgentAuthLoginStatus,
	AgentDeviceAuthInfo,
} from '$shared/agent-auth';

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

export async function getAgentAuthStatus(agent: AgentName): Promise<AgentAuthStatus> {
	const result = await apiGet<Record<string, AgentAuthStatus>>(
		`/api/v1/agents/auth?agent=${encodeURIComponent(agent)}`,
	);
	return result[agent];
}

export async function getAgentReadiness(): Promise<Record<string, AgentReadiness>> {
	return apiGet<Record<string, AgentReadiness>>('/api/v1/agents/readiness');
}

export async function getAgentCatalog(): Promise<AgentCatalog> {
	return apiGet<AgentCatalog>('/api/v1/agents');
}

export async function launchAgentAuthLogin(agent: AgentName): Promise<AgentAuthLoginResult> {
	return apiPost<AgentAuthLoginResult>('/api/v1/agents/auth/login', { agentId: agent });
}

export async function completeAgentAuthLogin(
	agent: AgentName,
	sessionId: string,
	code: string,
): Promise<AgentAuthLoginCompleteResult> {
	return apiPost<AgentAuthLoginCompleteResult>('/api/v1/agents/auth/login/complete', {
		agentId: agent,
		sessionId,
		code,
	});
}

export async function getAgentAuthLoginStatus(
	agent: AgentName,
	expectedSessionId?: string,
): Promise<AgentAuthLoginStatus> {
	const sessionQuery = expectedSessionId ? `&session=${encodeURIComponent(expectedSessionId)}` : '';
	return apiGet<AgentAuthLoginStatus>(
		`/api/v1/agents/auth/login?agent=${encodeURIComponent(agent)}${sessionQuery}`,
	);
}
