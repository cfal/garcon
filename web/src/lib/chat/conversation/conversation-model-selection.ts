import type { ApiProtocol } from '$shared/api-providers';
import type { ConversationExecutionSelection } from './conversation-execution-draft-state.svelte.js';

export type ConversationModelSelection = Pick<
	ConversationExecutionSelection,
	'model' | 'apiProviderId' | 'modelEndpointId' | 'modelProtocol'
>;

type ConversationModelSelectionSource = Pick<
	ConversationExecutionSelection,
	'agentId' | 'model' | 'apiProviderId' | 'modelEndpointId' | 'modelProtocol'
>;

interface ConversationModelSelectionCatalog {
	selectionFor(
		agentId: string,
		model: string,
		modelEndpointId?: string | null,
	): {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	};
}

export function resolveConversationModelSelection(
	source: ConversationModelSelectionSource,
	catalog: ConversationModelSelectionCatalog,
): ConversationModelSelection {
	const resolved = catalog.selectionFor(source.agentId, source.model, source.modelEndpointId);
	if (resolved.modelEndpointId || !source.modelEndpointId) return resolved;
	return {
		model: resolved.model,
		apiProviderId: source.apiProviderId,
		modelEndpointId: source.modelEndpointId,
		modelProtocol: source.modelProtocol,
	};
}
