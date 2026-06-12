// Agent HTTP client. Agents own runtime auth, readiness, and catalog state.

import { apiGet, apiPost } from './client.js';
import type { AgentCatalog, AgentId } from '$shared/agents';

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

export interface DeviceAuthInfo {
	url: string;
	code: string;
}

export interface AgentAuthLoginResult {
	launched: boolean;
	alreadyRunning: boolean;
	deviceAuth?: DeviceAuthInfo;
}

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
