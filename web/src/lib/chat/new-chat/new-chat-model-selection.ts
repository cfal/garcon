import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import type { ResolvedModelSelection } from '$shared/start-selection';

export function resolveNewChatModelSelection(
	catalog: Pick<ModelCatalogStore, 'getModelForSelection' | 'selectionFor'>,
	agentId: SessionAgentId,
	modelValue: string,
	target: ResolvedModelSelection | null,
): ResolvedModelSelection | null {
	const endpointId = target?.modelEndpointId;
	const selected = catalog.getModelForSelection(agentId, modelValue, endpointId);
	if (!selected) return null;
	const selection = catalog.selectionFor(agentId, modelValue, endpointId);
	if (!selection) return null;
	if (target && (
		(selection.model !== target.model && selected.value !== target.model) ||
		selection.apiProviderId !== target.apiProviderId ||
		selection.modelEndpointId !== target.modelEndpointId ||
		selection.modelProtocol !== target.modelProtocol
	)) return null;
	return selection;
}
