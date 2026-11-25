// Agent, model, and permission mode state for the active chat session.
// Manages cycling through permission modes and models.

import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import { createEmptyAgentSettings } from '$shared/agent-settings';

export interface ModelSelectionPayload {
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
}

export class AgentState {
	executorId = $state('local');
	projectPath = $state('');
	agentId = $state<SessionAgentId>('claude');
	model = $state('opus');
	apiProviderId = $state<string | null>(null);
	modelEndpointId = $state<string | null>(null);
	modelProtocol = $state<ApiProtocol | null>(null);
	permissionMode = $state<PermissionMode>('default');
	thinkingMode = $state<ThinkingMode>('none');
	agentSettings = $state<AgentSettingsEnvelope>(createEmptyAgentSettings('claude'));

	/** Sets the selected agent. */
	setAgentId(agentId: SessionAgentId): void {
		this.agentId = agentId;
	}

	setAgentSettings(settings: AgentSettingsEnvelope): void {
		if (settings.ownerId !== this.agentId) return;
		this.agentSettings = settings;
	}

	/** Sets a thinking mode supported by the selected agent. */
	setThinkingMode(mode: ThinkingMode): void {
		this.thinkingMode = mode;
	}

	/** Sets the full model selection including API provider metadata. */
	setModelSelection(selection: ModelSelectionPayload): void {
		this.model = selection.model;
		this.apiProviderId = selection.apiProviderId ?? null;
		this.modelEndpointId = selection.modelEndpointId ?? null;
		this.modelProtocol = selection.modelProtocol ?? null;
	}
}
