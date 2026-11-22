import type { AgentMetadata, ModelOption } from '$lib/agents/model-catalog-store.svelte';
import type { AgentCatalogEntry } from '$shared/agents';
import { PERMISSION_MODE_VALUES } from '$shared/chat-modes';
import type { ResolvedModelSelection } from '$shared/start-selection';

export function nativeCatalogAgent(id: string, models: ModelOption[] = []): AgentMetadata & AgentCatalogEntry {
	return {
		id, label: id, kind: 'agent', executionPolicy: 'conversation', selectionLabel: 'Model', inputFormatByModel: {},
		supportsCompact: false, supportsFork: true, supportsForkAtMessage: true, supportsForkWhileRunning: true,
		supportsUpdateProjectPath: false, supportsSteering: false, supportsImages: true,
		fileAttachmentMimeTypes: [], acceptsApiProviderEndpoints: false, supportedProtocols: [],
		authLoginSupported: true, supportedPermissionModes: [...PERMISSION_MODE_VALUES], supportedThinkingModes: [],
		settings: [], defaultSettings: { ownerId: id, schemaVersion: 1, values: {} },
		generation: null, requiresStrictModelDiscovery: false, defaultModel: models[0]?.value ?? '', models,
	};
}

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
