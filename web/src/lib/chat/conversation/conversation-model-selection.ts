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
	): ConversationModelSelection | null;
}

export function resolveConversationModelSelection(
	source: ConversationModelSelectionSource,
	catalog: ConversationModelSelectionCatalog,
): ConversationModelSelection {
	const resolved = catalog.selectionFor(source.agentId, source.model, source.modelEndpointId);
	if (resolved && (resolved.modelEndpointId || !source.modelEndpointId)) return resolved;
	return {
		model: resolved?.model ?? source.model,
		apiProviderId: source.apiProviderId,
		modelEndpointId: source.modelEndpointId,
		modelProtocol: source.modelProtocol,
	};
}
