import type { ModelCatalogStore } from './model-catalog-store.svelte.js';

export function isCustomProviderSelectionAvailable(
	catalog: Pick<ModelCatalogStore, 'getModelForSelection'>,
	selection: {
		agentId?: string | null;
		model?: string | null;
		apiProviderId?: string | null;
		modelEndpointId?: string | null;
	},
): boolean {
	if (!selection.apiProviderId && !selection.modelEndpointId) return true;
	if (
		!selection.apiProviderId ||
		!selection.modelEndpointId ||
		!selection.agentId ||
		!selection.model
	)
		return false;
	return (
		catalog.getModelForSelection(selection.agentId, selection.model, selection.modelEndpointId)
			?.apiProviderId === selection.apiProviderId
	);
}
