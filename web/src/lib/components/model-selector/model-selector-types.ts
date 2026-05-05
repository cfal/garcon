import type { SessionProvider } from '$lib/types/app';
import type { ModelOption } from '$lib/stores/model-catalog.svelte';
import type { ApiProtocol } from '$shared/providers';

export type ModelSelectorHarnessMode = 'select' | 'fixed' | 'hidden';
export type ModelSelectorSourceMode = 'select' | 'hidden';
export type ModelSelectorSurface = 'composer' | 'settings';

export interface ModelSelectorMode {
	harness: ModelSelectorHarnessMode;
	source: ModelSelectorSourceMode;
	surface: ModelSelectorSurface;
}

export interface ModelSelectorValue {
	harnessId: SessionProvider;
	model: string;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
}

export interface ModelSelectorChange {
	harnessId: SessionProvider;
	modelValue: string;
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
}

export interface HarnessSelectorOption {
	value: SessionProvider;
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
