import { apiFetch } from '$lib/api/client.js';
import { agentLabelFor } from '$lib/i18n/agent-labels';
import type { SessionAgentId } from '$lib/types/app';
import { CLAUDE_MODELS, CODEX_MODELS, AMP_MODELS, FACTORY_MODELS, PI_MODELS } from '$shared/models';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
	DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
	isEndpointOnlyAgentId,
	isVisibleAgentId,
} from '$shared/agents';
import {
	isApiProviderTemplateId,
	type ApiProtocol,
	type ApiProviderCatalogEntry,
	type ApiProviderEndpointCatalogEntry,
	type ApiProviderTemplateId,
	type ModelDiscoveryKind,
	type OpenAiEndpointCapabilities,
} from '$shared/api-providers';

export interface ModelOption {
	value: string;
	label: string;
	supportsImages?: boolean;
	isLocal?: boolean;
	apiProviderId?: string;
	endpointId?: string;
	rawModel?: string;
	protocol?: ApiProtocol;
}

export interface AgentMetadata {
	id: string;
	label: string;
	description?: string;
	supportsFork: boolean;
	supportsImages: boolean;
	acceptsApiProviderEndpoints: boolean;
	supportedProtocols: ApiProtocol[];
	authLoginSupported: boolean;
	defaultModel: string;
}

type AgentModels = Record<string, ModelOption[]>;
type AgentMetadataMap = Record<string, AgentMetadata>;

interface ModelCatalogSnapshot {
	agentModels: AgentModels;
	agentMetadata: AgentMetadataMap;
	apiProviderCatalog: ApiProviderCatalogEntry[];
	lastFetchedAt: number | null;
}

const STORAGE_KEY = 'pref_model_catalog_v2';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

const STATIC_FALLBACKS: AgentModels = {
	claude: CLAUDE_MODELS.OPTIONS,
	codex: CODEX_MODELS.OPTIONS,
	cursor: [],
	opencode: [],
	amp: AMP_MODELS.OPTIONS,
	factory: FACTORY_MODELS.OPTIONS,
	pi: PI_MODELS.OPTIONS,
	[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: [],
	[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: [],
	[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: [],
};

const STATIC_AGENT_METADATA: AgentMetadataMap = {
	claude: { id: 'claude', label: 'Claude', supportsFork: true, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['anthropic-messages'], authLoginSupported: true, defaultModel: CLAUDE_MODELS.DEFAULT },
	codex: { id: 'codex', label: 'Codex', supportsFork: true, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-compatible'], authLoginSupported: true, defaultModel: CODEX_MODELS.DEFAULT },
	cursor: { id: 'cursor', label: 'Cursor', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], authLoginSupported: false, defaultModel: '' },
	opencode: { id: 'opencode', label: 'OpenCode', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], authLoginSupported: false, defaultModel: '' },
	amp: { id: 'amp', label: 'Amp', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], authLoginSupported: false, defaultModel: AMP_MODELS.DEFAULT },
	factory: { id: 'factory', label: 'Factory', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], authLoginSupported: false, defaultModel: FACTORY_MODELS.DEFAULT },
	pi: { id: 'pi', label: 'Pi', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], authLoginSupported: false, defaultModel: PI_MODELS.DEFAULT },
	[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: { id: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID, label: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL, supportsFork: false, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-compatible'], authLoginSupported: false, defaultModel: '' },
	[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: { id: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID, label: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL, supportsFork: false, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-compatible'], authLoginSupported: false, defaultModel: '' },
	[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: { id: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID, label: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL, supportsFork: false, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['anthropic-messages'], authLoginSupported: false, defaultModel: '' },
};

function normalizeAgentLabel(id: string, label: string): string {
	if (id === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID) {
		return DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL;
	}
	if (id === DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID) {
		return DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL;
	}
	if (id === DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID) {
		return DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL;
	}
	return label;
}

function normalizeModelOption(value: unknown): ModelOption | null {
	if (!value || typeof value !== 'object') return null;
	const maybe = value as Record<string, unknown>;
	if (typeof maybe.value !== 'string' || typeof maybe.label !== 'string') return null;
	return {
		value: maybe.value,
		label: maybe.label,
		supportsImages: typeof maybe.supportsImages === 'boolean' ? maybe.supportsImages : undefined,
		isLocal: typeof maybe.isLocal === 'boolean' ? maybe.isLocal : undefined,
		apiProviderId: typeof maybe.apiProviderId === 'string' ? maybe.apiProviderId : undefined,
		endpointId: typeof maybe.endpointId === 'string' ? maybe.endpointId : undefined,
		rawModel: typeof maybe.rawModel === 'string' ? maybe.rawModel : undefined,
		protocol: maybe.protocol === 'openai-compatible' || maybe.protocol === 'anthropic-messages'
			? maybe.protocol as ApiProtocol
			: undefined,
	};
}

function normalizeProtocols(value: unknown): ApiProtocol[] {
	if (!Array.isArray(value)) return [];
	return value.filter((p): p is ApiProtocol => p === 'openai-compatible' || p === 'anthropic-messages');
}

function normalizeTemplateId(value: unknown): ApiProviderTemplateId | undefined {
	if (isApiProviderTemplateId(value)) return value;
	return undefined;
}

function normalizeModelDiscovery(value: unknown): ModelDiscoveryKind | undefined {
	if (
		value === 'none' ||
		value === 'anthropic-models' ||
		value === 'openai-models' ||
		value === 'ollama-tags' ||
		value === 'openrouter-models'
	) {
		return value;
	}
	return undefined;
}

function normalizeOpenAiCapabilities(value: unknown): OpenAiEndpointCapabilities | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	return {
		chatCompletions: raw.chatCompletions === true,
		responses: raw.responses === true,
	};
}

function normalizeApiProviderEndpoint(value: unknown): ApiProviderEndpointCatalogEntry | null {
	if (!value || typeof value !== 'object') return null;
	const entry = value as Record<string, unknown>;
	const protocol = entry.protocol === 'openai-compatible' || entry.protocol === 'anthropic-messages'
		? entry.protocol
		: null;
	if (
		typeof entry.id !== 'string' ||
		!protocol ||
		typeof entry.baseUrl !== 'string' ||
		typeof entry.defaultModel !== 'string' ||
		typeof entry.supportsImages !== 'boolean' ||
		typeof entry.hasApiKey !== 'boolean'
	) {
		return null;
	}
	return {
		id: entry.id,
		protocol,
		baseUrl: entry.baseUrl,
		capabilities: normalizeOpenAiCapabilities(entry.capabilities),
		defaultModel: entry.defaultModel,
		models: Array.isArray(entry.models)
			? entry.models.map((model) => normalizeModelOption(model)).filter((model): model is ModelOption => model !== null)
			: [],
		supportsImages: entry.supportsImages,
		hasApiKey: entry.hasApiKey,
		apiKeyLabel: typeof entry.apiKeyLabel === 'string' ? entry.apiKeyLabel : undefined,
		modelDiscovery: normalizeModelDiscovery(entry.modelDiscovery),
	};
}

function normalizeApiProviders(value: unknown): ApiProviderCatalogEntry[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const e = entry as Record<string, unknown>;
			if (
				typeof e.id !== 'string' ||
				typeof e.label !== 'string' ||
				typeof e.createdAt !== 'string' ||
				typeof e.updatedAt !== 'string' ||
				!Array.isArray(e.endpoints)
			) {
				return null;
			}
			const endpoints = e.endpoints
				.map((endpoint) => normalizeApiProviderEndpoint(endpoint))
				.filter((endpoint): endpoint is ApiProviderEndpointCatalogEntry => endpoint !== null);
			if (endpoints.length === 0) return null;
			const templateId = normalizeTemplateId(e.templateId);
			return {
				id: e.id,
				label: e.label,
				...(templateId ? { templateId } : {}),
				createdAt: e.createdAt,
				updatedAt: e.updatedAt,
				endpoints,
			} satisfies ApiProviderCatalogEntry;
		})
	.filter((e): e is ApiProviderCatalogEntry => e !== null);
}

function mergeStaticModels(remote: ModelOption[] | undefined, fallback: ModelOption[]): ModelOption[] {
	if (!remote?.length) return fallback;
	const seen = new Set(remote.map((m) => m.value));
	const missing = fallback.filter((m) => !seen.has(m.value));
	return missing.length ? [...remote, ...missing] : remote;
}

function removeLegacyPiDefaultModels(models: ModelOption[] | undefined): ModelOption[] | undefined {
	return models?.filter((model) => model.value !== 'default');
}

function normalizeAgentDefaultModel(id: string, defaultModel: string): string {
	return id === 'pi' && defaultModel === 'default' ? '' : defaultModel;
}

function mergeWithFallbacks(models: AgentModels): AgentModels {
	const result: AgentModels = {
		claude: mergeStaticModels(models.claude, STATIC_FALLBACKS.claude!),
		codex: mergeStaticModels(models.codex, STATIC_FALLBACKS.codex!),
		cursor: models.cursor?.length ? models.cursor : [],
		amp: models.amp?.length ? models.amp : STATIC_FALLBACKS.amp!,
		factory: mergeStaticModels(models.factory, STATIC_FALLBACKS.factory!),
		pi: mergeStaticModels(removeLegacyPiDefaultModels(models.pi), STATIC_FALLBACKS.pi!),
		opencode: models.opencode?.length ? models.opencode : [],
		[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: models[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]?.length ? models[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID] : [],
		[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: models[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]?.length ? models[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID] : [],
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: models[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]?.length ? models[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID] : [],
	};
	for (const [key, value] of Object.entries(models)) {
		if (!(key in result) && value?.length && isVisibleAgentId(key)) {
			result[key] = value;
		}
	}
	return result;
}

function hasExplicitEmptyPiModels(models: AgentModels): boolean {
	return Array.isArray(models.pi) && models.pi.length === 0;
}

function piUnavailableError(data: unknown, status: number): string {
	if (data && typeof data === 'object') {
		const root = data as Record<string, unknown>;
		if (typeof root.reason === 'string' && root.reason) return root.reason;
		if (typeof root.error === 'string' && root.error) return root.error;
	}
	return `Pi model discovery failed: ${status}`;
}

function filterVisibleAgentMetadata(agentMetadata: AgentMetadataMap): AgentMetadataMap {
	return Object.fromEntries(
		Object.entries(agentMetadata)
			.filter(([id]) => isVisibleAgentId(id))
			.map(([id, metadata]) => [
				id,
				{
					...metadata,
					label: normalizeAgentLabel(id, metadata.label),
					defaultModel: normalizeAgentDefaultModel(id, metadata.defaultModel),
				}
			])
	);
}

function parseCatalogResponse(data: unknown): {
	agentModels: AgentModels;
	agentMetadata: AgentMetadataMap;
	apiProviderCatalog: ApiProviderCatalogEntry[];
} | null {
	if (!data || typeof data !== 'object') return null;
	const root = data as Record<string, unknown>;
	const catalog = root.catalog;
	if (!catalog || typeof catalog !== 'object') return null;
	const inner = catalog as Record<string, unknown>;
	if (!Array.isArray(inner.agents)) return null;

	const agentModels: AgentModels = {};
	const agentMetadata: AgentMetadataMap = {};

	for (const entry of inner.agents as Array<Record<string, unknown>>) {
		if (typeof entry.id !== 'string') continue;

		const id = entry.id;
		if (!isVisibleAgentId(id)) continue;
			agentMetadata[id] = {
				id,
				label: typeof entry.label === 'string' ? entry.label : id,
				description: typeof entry.description === 'string' ? entry.description : undefined,
				supportsFork: Boolean(entry.supportsFork),
				supportsImages: Boolean(entry.supportsImages),
				acceptsApiProviderEndpoints: Boolean(entry.acceptsApiProviderEndpoints),
				supportedProtocols: normalizeProtocols(entry.supportedProtocols),
				authLoginSupported: Boolean(entry.authLoginSupported),
				defaultModel: typeof entry.defaultModel === 'string' ? entry.defaultModel : '',
			};

		if (Array.isArray(entry.models)) {
			agentModels[id] = entry.models
				.map((m) => normalizeModelOption(m))
				.filter((m): m is ModelOption => m !== null);
		}
	}

	return {
		agentModels,
		agentMetadata,
		apiProviderCatalog: normalizeApiProviders(inner.apiProviders),
	};
}

function readPersisted(): ModelCatalogSnapshot {
	if (typeof window === 'undefined') {
		return {
			agentModels: { ...STATIC_FALLBACKS },
			agentMetadata: { ...STATIC_AGENT_METADATA },
			apiProviderCatalog: [],
			lastFetchedAt: null,
		};
	}

	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return {
				agentModels: { ...STATIC_FALLBACKS },
				agentMetadata: { ...STATIC_AGENT_METADATA },
				apiProviderCatalog: [],
				lastFetchedAt: null,
			};
		}
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const agentModels = mergeWithFallbacks(
			typeof parsed.agentModels === 'object' && parsed.agentModels !== null
				? parsed.agentModels as AgentModels
				: {},
		);
		const agentMetadata = filterVisibleAgentMetadata(
				typeof parsed.agentMetadata === 'object' && parsed.agentMetadata !== null
					? { ...STATIC_AGENT_METADATA, ...(parsed.agentMetadata as AgentMetadataMap) }
					: { ...STATIC_AGENT_METADATA }
		);
		const apiProviderCatalog = normalizeApiProviders(parsed.apiProviderCatalog);
		const lastFetchedAt =
			typeof parsed.lastFetchedAt === 'number' ? parsed.lastFetchedAt : null;
		return { agentModels, agentMetadata, apiProviderCatalog, lastFetchedAt };
	} catch {
		return {
			agentModels: { ...STATIC_FALLBACKS },
			agentMetadata: { ...STATIC_AGENT_METADATA },
			apiProviderCatalog: [],
			lastFetchedAt: null,
		};
	}
}

function persist(snapshot: ModelCatalogSnapshot): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
	} catch {
	}
}

function hasNonEmptyPiModels(snapshot: ModelCatalogSnapshot): boolean {
	return Boolean(snapshot.agentModels.pi?.length);
}

export class ModelCatalogStore {
	agentModels = $state<AgentModels>({ ...STATIC_FALLBACKS });
	agentMetadata = $state<AgentMetadataMap>({ ...STATIC_AGENT_METADATA });
	apiProviderCatalog = $state<ApiProviderCatalogEntry[]>([]);
	lastFetchedAt = $state<number | null>(null);
	isRefreshing = $state(false);
	error = $state<string | null>(null);
	version = $state(0);

	constructor() {
		this.hydrateFromStorage();
	}

	getAgents(): SessionAgentId[] {
		return Object.keys(this.agentMetadata).filter(isVisibleAgentId) as SessionAgentId[];
	}

	getSelectableAgents(): SessionAgentId[] {
		return this.getAgents().filter((agentId) => {
			if (!isEndpointOnlyAgentId(agentId)) return true;
			return this.getModels(agentId as SessionAgentId).length > 0;
		}) as SessionAgentId[];
	}

	getAgentMetadataList(): AgentMetadata[] {
		return Object.values(this.agentMetadata)
			.filter((metadata) => isVisibleAgentId(metadata.id));
	}

	getAgent(id: string): AgentMetadata | null {
		if (!isVisibleAgentId(id)) return null;
		return this.agentMetadata[id] ?? null;
	}

	getAgentLabel(id: string): string {
		return agentLabelFor(id, this.agentMetadata[id]?.label ?? id);
	}

	getModels(agentId: SessionAgentId): ModelOption[] {
		if (!isVisibleAgentId(agentId)) return [];
		return this.agentModels[agentId] ?? [];
	}

	getDefaultModel(agentId: SessionAgentId): string {
		return this.agentMetadata[agentId]?.defaultModel
			|| this.getModels(agentId)[0]?.value
			|| '';
	}

	getModel(agentId: SessionAgentId, model: string): ModelOption | null {
		return this.getModels(agentId).find((entry) =>
			entry.value === model || entry.rawModel === model
		) ?? null;
	}

	getModelForSelection(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): ModelOption | null {
		const models = this.getModels(agentId);
		if (modelEndpointId) {
			const matchedEndpointModel = models.find((entry) =>
				entry.endpointId === modelEndpointId && (entry.value === model || entry.rawModel === model)
			);
			if (matchedEndpointModel) return matchedEndpointModel;
		}
		return models.find((entry) => entry.value === model || entry.rawModel === model) ?? null;
	}

	supportsFork(agentId: SessionAgentId): boolean {
		if (!isVisibleAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsFork ?? false;
	}

	supportsImages(agentId: SessionAgentId, model?: string, modelEndpointId?: string | null): boolean {
		if (!isVisibleAgentId(agentId)) return false;
		if (model) {
			const selected = this.getModelForSelection(agentId, model, modelEndpointId);
			if (selected && typeof selected.supportsImages === 'boolean') {
				return selected.supportsImages;
			}
		}
		return this.agentMetadata[agentId]?.supportsImages ?? false;
	}

	isLocalModel(agentId: SessionAgentId, model: string, modelEndpointId?: string | null): boolean {
		return this.getModelForSelection(agentId, model, modelEndpointId)?.isLocal === true;
	}

	selectionFor(agentId: SessionAgentId, model: string, modelEndpointId?: string | null): {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	} {
		const selected = this.getModelForSelection(agentId, model, modelEndpointId);
		return {
			model: selected?.rawModel ?? model,
			apiProviderId: selected?.apiProviderId ?? null,
			modelEndpointId: selected?.endpointId ?? null,
			modelProtocol: selected?.protocol ?? null,
		};
	}

	selectionValueFor(agentId: SessionAgentId, model: string, modelEndpointId?: string | null): string {
		return this.getModelForSelection(agentId, model, modelEndpointId)?.value ?? model;
	}

	findEndpoint(endpointId: string): {
		apiProvider: ApiProviderCatalogEntry;
		endpoint: ApiProviderCatalogEntry['endpoints'][number];
	} | null {
		for (const apiProvider of this.apiProviderCatalog) {
			const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
			if (endpoint) return { apiProvider, endpoint };
		}
		return null;
	}

	async #resolveStrictPiModels(
		models: AgentModels,
		metadata: AgentMetadataMap
	): Promise<{ models: AgentModels; metadata: AgentMetadataMap; persistable: boolean }> {
		const response = await apiFetch('/api/v1/models?agent=pi');
		const data = (await response.json().catch(() => ({}))) as unknown;
		const catalogResult = parseCatalogResponse(data);
		if (response.ok) {
			if (!catalogResult?.agentModels.pi) {
				throw new Error('Pi model catalog response is invalid');
			}
			return {
				models: { ...models, pi: catalogResult.agentModels.pi },
				metadata: filterVisibleAgentMetadata({ ...metadata, ...catalogResult.agentMetadata }),
				persistable: true,
			};
		}

		const previousPiModels = this.agentModels.pi ?? [];
		const stalePiModels = catalogResult?.agentModels.pi ?? [];
		const nextPiModels = stalePiModels.length > 0 ? stalePiModels : previousPiModels;
		this.error = piUnavailableError(data, response.status);
		return {
			models: { ...models, pi: nextPiModels },
			metadata: catalogResult
				? filterVisibleAgentMetadata({ ...metadata, ...catalogResult.agentMetadata })
				: metadata,
			persistable: false,
		};
	}

	hydrateFromStorage(): void {
		const snapshot = readPersisted();
		this.agentModels = snapshot.agentModels;
		this.agentMetadata = snapshot.agentMetadata;
		this.apiProviderCatalog = snapshot.apiProviderCatalog;
		this.lastFetchedAt = snapshot.lastFetchedAt;
		this.version += 1;
	}

	async refreshIfStale(ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
		if (!this.isStale(ttlMs)) return;
		await this.forceRefresh();
	}

	isStale(ttlMs: number = DEFAULT_TTL_MS): boolean {
		if (this.lastFetchedAt === null) return true;
		return Date.now() - this.lastFetchedAt >= ttlMs;
	}

	async forceRefresh(): Promise<void> {
		if (this.isRefreshing) return;
		this.isRefreshing = true;
		this.error = null;

		try {
			const response = await apiFetch('/api/v1/models');
			if (!response.ok) {
				throw new Error(`Failed to fetch model catalog: ${response.status}`);
			}
			const data = (await response.json()) as unknown;

			const catalogResult = parseCatalogResponse(data);
			let persistable = true;
			if (catalogResult && Object.keys(catalogResult.agentModels).length > 0) {
				let nextModels = mergeWithFallbacks(catalogResult.agentModels);
				let nextMetadata = filterVisibleAgentMetadata({ ...STATIC_AGENT_METADATA, ...catalogResult.agentMetadata });
				if (hasExplicitEmptyPiModels(catalogResult.agentModels)) {
					const strictPi = await this.#resolveStrictPiModels(nextModels, nextMetadata);
					nextModels = strictPi.models;
					nextMetadata = strictPi.metadata;
					persistable = strictPi.persistable;
				}
				this.agentModels = nextModels;
				this.agentMetadata = nextMetadata;
				this.apiProviderCatalog = catalogResult.apiProviderCatalog;
			} else {
				throw new Error('Model catalog response is invalid');
			}

			this.lastFetchedAt = persistable ? Date.now() : null;
			const snapshot = {
				agentModels: this.agentModels,
				agentMetadata: this.agentMetadata,
				apiProviderCatalog: this.apiProviderCatalog,
				lastFetchedAt: this.lastFetchedAt,
			};
			if (persistable || hasNonEmptyPiModels(snapshot)) {
				persist(snapshot);
			}
			this.version += 1;
		} catch (error) {
			this.error = error instanceof Error ? error.message : 'Unknown error';
		} finally {
			this.isRefreshing = false;
		}
	}
}

export function createModelCatalogStore(): ModelCatalogStore {
	return new ModelCatalogStore();
}
