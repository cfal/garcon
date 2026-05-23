import type { SessionAgentId } from '$lib/types/app';
import type { ModelOption } from '$lib/stores/model-catalog.svelte';
import type { ApiProtocol } from '$shared/api-providers';

export type ModelSelectorAgentMode = 'select' | 'fixed' | 'hidden';
export type ModelSelectorSourceMode = 'select' | 'hidden';
export type ModelSelectorSurface = 'composer' | 'settings';

export interface ModelSelectorMode {
	agent: ModelSelectorAgentMode;
	source: ModelSelectorSourceMode;
	surface: ModelSelectorSurface;
}

export interface ModelSelectorValue {
	agentId: SessionAgentId;
	model: string;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
}

export interface ModelSelectorChange {
	agentId: SessionAgentId;
	modelValue: string;
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
}

export interface AgentSelectorOption {
	value: SessionAgentId;
	label: string;
	description: string;
}

export interface ModelSourceOption {
	key: string;
	label: string;
	description: string;
	apiProviderId: string | null;
	endpointId: string | null;
	protocol: ApiProtocol | null;
	models: ModelOption[];
}

export interface FilteredModelResult {
	items: ModelOption[];
}

export interface ModelSelectorRow {
	value: string;
	label: string;
	searchText: string;
	model: ModelOption;
}

export interface FilteredModelRowsResult {
	items: ModelSelectorRow[];
}
