import type { SessionAgentId } from '$lib/types/app';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
import type { RecentAgentSetting } from '$shared/settings';
import {
	buildModelSources,
	modelDisplayLabel,
	modelSourceKeyFor,
	shouldShowSourceLabelForAgent,
} from './model-selector-options';
import type { ModelSelectorRecentOption } from './model-selector-types';

export const MODEL_SELECTOR_RECENTS_LIMIT = 20;

function recentAgentSettingKey(entry: RecentAgentSetting): string {
	return [
		entry.agentId,
		entry.model,
		entry.apiProviderId ?? '',
		entry.modelEndpointId ?? '',
		entry.modelProtocol ?? '',
	].join('\u001f');
}

export function buildModelSelectorRecents(
	modelCatalog: ModelCatalogStore,
	recents: RecentAgentSetting[],
): ModelSelectorRecentOption[] {
	const selectable = new Set(modelCatalog.getSelectableAgents());
	const rows: ModelSelectorRecentOption[] = [];

	for (const recent of recents) {
		const agentId = recent.agentId as SessionAgentId;
		if (!selectable.has(agentId)) continue;

		const modelValue = modelCatalog.selectionValueFor(
			agentId,
			recent.model,
			recent.modelEndpointId,
		);
		if (!modelValue) continue;

		const selectedModel = modelCatalog.getModelForSelection(
			agentId,
			modelValue,
			recent.modelEndpointId,
		);
		if (!selectedModel) continue;

		const sourceKey = modelSourceKeyFor(agentId, selectedModel);
		const sources = buildModelSources(modelCatalog, agentId);
		const sourceOption = sources.find((source) => source.key === sourceKey) ?? null;
		if (!sourceOption) continue;

		const agentLabel = modelCatalog.getAgentLabel(agentId);
		const sourceLabel = shouldShowSourceLabelForAgent(modelCatalog, agentId, sourceOption, sources)
			? sourceOption.label
			: '';
		const modelLabel = modelDisplayLabel(selectedModel, modelValue, sourceOption);

		rows.push({
			id: recentAgentSettingKey(recent),
			agentId,
			modelValue,
			model: selectedModel.rawModel ?? recent.model,
			apiProviderId: selectedModel.apiProviderId ?? null,
			modelEndpointId: selectedModel.endpointId ?? null,
			modelProtocol: selectedModel.protocol ?? null,
			agentLabel,
			modelLabel,
			sourceLabel,
			displayLabel: [agentLabel, sourceLabel, modelLabel].filter(Boolean).join(' · '),
		});

		if (rows.length >= MODEL_SELECTOR_RECENTS_LIMIT) break;
	}

	return rows;
}
