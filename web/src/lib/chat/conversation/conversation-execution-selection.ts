import type { AgentHandoffTarget } from '$shared/chat-command-contracts';
import { effectiveExecutorId } from '$shared/executors';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import type { PermissionMode, ThinkingMode } from '$shared/chat-modes';
import { cloneAgentSettings } from '$shared/agent-settings';

export interface ConversationExecutionSelection extends AgentHandoffTarget {
	agentId: string;
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	agentSettings: AgentSettingsEnvelope;
}

interface ConversationExecutionProjection {
	executorId?: string | null;
	projectPath?: string;
	agentId: string;
	model: string | null;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	agentSettings: AgentSettingsEnvelope;
}

export function executionSelectionFromProjection(
	projection: ConversationExecutionProjection | null | undefined,
): ConversationExecutionSelection | null {
	if (!projection?.model || projection.agentSettings.ownerId !== projection.agentId) return null;
	return {
		executorId: effectiveExecutorId(projection.executorId),
		projectPath: projection.projectPath,
		agentId: projection.agentId,
		model: projection.model,
		apiProviderId: projection.apiProviderId ?? null,
		modelEndpointId: projection.modelEndpointId ?? null,
		modelProtocol: projection.modelProtocol ?? null,
		permissionMode: projection.permissionMode,
		thinkingMode: projection.thinkingMode,
		agentSettings: cloneAgentSettings(projection.agentSettings),
	};
}
