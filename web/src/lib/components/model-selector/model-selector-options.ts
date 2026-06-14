import type { SessionAgentId } from '$lib/types/app';
import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
import { nativeSourceLabelFor } from '$lib/i18n/agent-labels';
import type { ApiProtocol } from '$shared/api-providers';
import type {
	FilteredModelResult,
	FilteredModelRowsResult,
	AgentSelectorOption,
	ModelSelectorChange,
	ModelSelectorRow,
	ModelSelectorValue,
	ModelSourceOption,
} from './model-selector-types';

export function nativeSourceKey(agentId: SessionAgentId): string {
	return `native:${agentId}`;
}

export function endpointSourceKey(endpointId: string): string {
	return `endpoint:${endpointId}`;
}

export function modelSourceKeyFor(agentId: SessionAgentId, model: ModelOption): string {
	if (model.endpointId) return endpointSourceKey(model.endpointId);
	return nativeSourceKey(agentId);
}

export function buildAgentOptions(modelCatalog: ModelCatalogStore): AgentSelectorOption[] {
	return modelCatalog.getSelectableAgents().map((agentId) => {
		const metadata = modelCatalog.getAgent(agentId);
		return {
			value: agentId,
			label: modelCatalog.getAgentLabel(agentId),
			description: metadata?.description ?? '',
		};
	});
}

export function nativeSourceLabel(
	agentId: SessionAgentId,
	modelCatalog: ModelCatalogStore,
): string {
	return nativeSourceLabelFor(agentId, modelCatalog.getAgentLabel(agentId));
}

export function buildModelSources(
	modelCatalog: ModelCatalogStore,
	agentId: SessionAgentId,
): ModelSourceOption[] {
	const models = modelCatalog.getModels(agentId);
	const nativeModels: ModelOption[] = [];
	const endpointModels = new Map<string, ModelOption[]>();

	for (const model of models) {
		if (model.endpointId) {
			const key = endpointSourceKey(model.endpointId);
			const groupedModels = endpointModels.get(key);
			if (groupedModels) {
				groupedModels.push(model);
			} else {
				endpointModels.set(key, [model]);
			}
		} else {
			nativeModels.push(model);
		}
	}

	const sources: ModelSourceOption[] = [];
	if (nativeModels.length > 0) {
		sources.push({
			key: nativeSourceKey(agentId),
			label: nativeSourceLabel(agentId, modelCatalog),
			description: modelCatalog.getAgentLabel(agentId),
			apiProviderId: null,
			endpointId: null,
			protocol: null,
			models: nativeModels,
		});
	}

	for (const [key, groupedModels] of endpointModels) {
		const first = groupedModels[0];
		if (!first?.endpointId) continue;
		const found = modelCatalog.findEndpoint(first.endpointId);
		const protocol = first.protocol ?? found?.endpoint.protocol ?? null;
		const description = endpointDescription(found?.endpoint.baseUrl, protocol);
		const label = endpointSourceLabel(
			found?.apiProvider.label ?? first.apiProviderId ?? first.endpointId,
			found?.apiProvider.endpoints.length ?? 0,
			description,
			first.endpointId,
		);
		sources.push({
			key,
			label,
			description,
			apiProviderId: first.apiProviderId ?? found?.apiProvider.id ?? null,
			endpointId: first.endpointId,
			protocol,
			models: groupedModels,
		});
	}

	return sources;
}

export function findSelectedModelOption(
	modelCatalog: ModelCatalogStore,
	value: ModelSelectorValue,
): ModelOption | null {
	if (!value.agentId) return null;
	const modelValue = currentModelValue(modelCatalog, value);
	if (!modelValue) return null;
	return modelCatalog.getModelForSelection(value.agentId, modelValue, value.modelEndpointId);
}

export function currentModelValue(
	modelCatalog: ModelCatalogStore,
	value: ModelSelectorValue,
): string {
	const model = value.model || modelCatalog.getDefaultModel(value.agentId);
	return modelCatalog.selectionValueFor(value.agentId, model, value.modelEndpointId);
}

export function selectedSourceKey(
	modelCatalog: ModelCatalogStore,
	value: ModelSelectorValue,
): string | null {
	const selectedModel = findSelectedModelOption(modelCatalog, value);
	if (!selectedModel) {
		return buildModelSources(modelCatalog, value.agentId)[0]?.key ?? null;
	}
	return modelSourceKeyFor(value.agentId, selectedModel);
}

export function filterModelOptions(
	models: ModelOption[],
	query: string,
	source: ModelSourceOption | null = null,
): FilteredModelResult {
	const trimmed = query.trim();
	if (!trimmed) {
		return { items: models };
	}

	const tokens = tokenize(trimmed);
	const scored = models
		.map((model, index) => ({ model, index, score: scoreModel(model, tokens, source) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index);

	return {
		items: scored.map((entry) => entry.model),
	};
}

export function buildModelRows(
	models: ModelOption[],
	source: ModelSourceOption | null = null,
): ModelSelectorRow[] {
	return models.map((model) => {
		const label = modelDisplayLabel(model, model.value, source);
		return {
			value: model.value,
			label,
			searchText: buildModelSearchText(model, label),
			model,
		};
	});
}

export function filterModelRows(rows: ModelSelectorRow[], query: string): FilteredModelRowsResult {
	const trimmed = query.trim();
	if (!trimmed) {
		return { items: rows };
	}

	const tokens = tokenize(trimmed);
	const scored = rows
		.map((row, index) => ({ row, index, score: scoreModelRow(row, tokens) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index);

	return {
		items: scored.map((entry) => entry.row),
	};
}

export function buildModelSelectorChange(
	modelCatalog: ModelCatalogStore,
	agentId: SessionAgentId,
	modelValue: string,
): ModelSelectorChange | null {
	if (!agentId || !modelValue) return null;
	const selection = modelCatalog.selectionFor(agentId, modelValue);
	return {
		agentId,
		modelValue,
		model: selection.model,
		apiProviderId: selection.apiProviderId,
		modelEndpointId: selection.modelEndpointId,
		modelProtocol: selection.modelProtocol,
	};
}

export function modelDisplayLabel(
	model: ModelOption | null,
	fallback: string,
	source: ModelSourceOption | null = null,
): string {
	const label = model?.label || fallback || '';
	if (!model?.endpointId || !source) return label;
	return stripSourcePrefix(label, source);
}

export function stripSourcePrefix(label: string, source: ModelSourceOption): string {
	const candidates = [source.label, baseSourceLabel(source.label), source.apiProviderId ?? '']
		.map((candidate) => candidate.trim())
		.filter(Boolean);

	for (const candidate of Array.from(new Set(candidates))) {
		const prefix = `${candidate}:`;
		if (label.toLowerCase().startsWith(prefix.toLowerCase())) {
			return label.slice(prefix.length).trimStart();
		}
	}
	return label;
}

export function protocolLabel(protocol: ApiProtocol | null | undefined): string {
	if (protocol === 'anthropic-messages') return 'Anthropic';
	if (protocol === 'openai-compatible') return 'OpenAI';
	return '';
}

function endpointDescription(
	baseUrl: string | undefined,
	protocol: ApiProtocol | null | undefined,
): string {
	const label = protocolLabel(protocol);
	if (baseUrl && label) return `${label} - ${baseUrl}`;
	return baseUrl ?? label;
}

function endpointSourceLabel(
	providerLabel: string,
	providerEndpointCount: number,
	description: string,
	endpointId: string,
): string {
	if (providerEndpointCount <= 1) return providerLabel;
	return `${providerLabel} (${description || endpointId})`;
}

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function scoreModel(
	model: ModelOption,
	tokens: string[],
	source: ModelSourceOption | null,
): number {
	const label = model.label.toLowerCase();
	const displayLabel = modelDisplayLabel(model, '', source).toLowerCase();
	const value = model.value.toLowerCase();
	const raw = (model.rawModel ?? '').toLowerCase();
	const joined = `${label} ${displayLabel} ${value} ${raw}`;
	const compact = compactSearchText(joined);
	let score = 0;

	for (const token of tokens) {
		const compactToken = compactSearchText(token);
		if (label === token || displayLabel === token || value === token || raw === token) score += 12;
		else if (
			label.startsWith(token) ||
			displayLabel.startsWith(token) ||
			value.startsWith(token) ||
			raw.startsWith(token)
		) {
			score += 8;
		} else if (joined.includes(token)) score += 4;
		else if (compact.includes(compactToken)) score += 2;
		else return 0;
	}

	return score;
}

function buildModelSearchText(model: ModelOption, label: string): string {
	return [model.label, label, model.value, model.rawModel ?? ''].join(' ').toLowerCase();
}

function scoreModelRow(row: ModelSelectorRow, tokens: string[]): number {
	const label = row.label.toLowerCase();
	const value = row.value.toLowerCase();
	const raw = (row.model.rawModel ?? '').toLowerCase();
	const sourceLabel = row.model.label.toLowerCase();
	const joined = row.searchText;
	const compact = compactSearchText(joined);
	let score = 0;

	for (const token of tokens) {
		const compactToken = compactSearchText(token);
		if (label === token || value === token || raw === token || sourceLabel === token) score += 12;
		else if (
			label.startsWith(token) ||
			value.startsWith(token) ||
			raw.startsWith(token) ||
			sourceLabel.startsWith(token)
		) {
			score += 8;
		} else if (joined.includes(token)) score += 4;
		else if (compact.includes(compactToken)) score += 2;
		else return 0;
	}

	return score;
}

function compactSearchText(text: string): string {
	return text.replace(/[^a-z0-9]/g, '');
}

function baseSourceLabel(label: string): string {
	const parentheticalIndex = label.indexOf(' (');
	return parentheticalIndex >= 0 ? label.slice(0, parentheticalIndex) : label;
}
