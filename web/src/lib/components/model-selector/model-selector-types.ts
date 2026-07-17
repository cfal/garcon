import type { SessionAgentId } from '$lib/types/app';
import type { ModelOption } from '$lib/stores/model-catalog.svelte';
import type { ApiProtocol } from '$shared/api-providers';
import type { ThinkingMode } from '$shared/chat-modes';

export type ModelSelectorAgentMode = 'select' | 'fixed' | 'hidden';
export type ModelSelectorSourceMode = 'select' | 'hidden';
export type ModelSelectorSurface = 'composer' | 'settings';
export type ModelSelectorEffortMode = 'select' | 'hidden';

export interface ModelSelectorMode {
	agent: ModelSelectorAgentMode;
	source: ModelSelectorSourceMode;
	surface: ModelSelectorSurface;
	effort?: ModelSelectorEffortMode;
}

export interface ModelSelectorValue {
	agentId: SessionAgentId;
	model: string;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	thinkingMode?: ThinkingMode;
}

export interface ModelSelectorChange {
	agentId: SessionAgentId;
	modelValue: string;
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
	thinkingMode?: ThinkingMode;
}

export interface ModelSelectorRecentOption extends ModelSelectorChange {
	id: string;
	agentLabel: string;
	modelLabel: string;
	sourceLabel: string;
	displayLabel: string;
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
