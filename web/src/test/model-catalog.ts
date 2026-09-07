import type { ModelOption } from '$lib/agents/model-catalog-store.svelte';
import type { ResolvedModelSelection } from '$shared/start-selection';

function matchesModel(entry: ModelOption, model: string): boolean {
	return entry.value === model || entry.rawModel === model;
}

export function findModelForSelection(
	models: readonly ModelOption[],
	model: string,
	modelEndpointId?: string | null,
): ModelOption | null {
	if (modelEndpointId === null) {
		return models.find((entry) => !entry.endpointId && matchesModel(entry, model)) ?? null;
	}
	if (modelEndpointId !== undefined) {
		return models.find(
			(entry) => entry.endpointId === modelEndpointId && matchesModel(entry, model),
		) ?? null;
	}
	return (
		models.find((entry) => entry.value === model) ??
		models.find((entry) => !entry.endpointId && entry.rawModel === model) ??
		null
	);
}

export function resolveModelSelection(
	models: readonly ModelOption[],
	model: string,
	modelEndpointId?: string | null,
): ResolvedModelSelection | null {
	const selected = findModelForSelection(models, model, modelEndpointId);
	if (!selected && modelEndpointId) return null;
	return {
		model: selected?.rawModel ?? model,
		apiProviderId: selected?.apiProviderId ?? null,
		modelEndpointId: selected?.endpointId ?? null,
		modelProtocol: selected?.protocol ?? null,
	};
}

export function modelValueForSelection(
	models: readonly ModelOption[],
	model: string,
	modelEndpointId?: string | null,
): string {
	return findModelForSelection(models, model, modelEndpointId)?.value ?? model;
}
