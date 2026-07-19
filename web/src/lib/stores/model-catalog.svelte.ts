import { apiFetch } from '$lib/api/client.js';
import { agentLabelFor } from '$lib/i18n/agent-labels';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import type { SessionAgentId } from '$lib/types/app';
import type { ModelCatalogResponse } from '$shared/model-catalog';
import {
	isAgentSettingLabelKey,
	isAgentSettingOptionLabelKey,
	parseAgentSettingsEnvelope,
	type AgentSettingDescriptor,
	type AgentSettingsEnvelope,
} from '$shared/agent-integration';
import { createEmptyAgentSettings } from '$lib/agents/agent-settings.js';
import { isAgentId } from '$shared/agents';
import {
	isPermissionMode,
	isThinkingMode,
	type PermissionMode,
	type ThinkingMode,
} from '$shared/chat-modes';
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
	supportsForkAtMessage: boolean;
	supportsForkWhileRunning: boolean;
	supportsUpdateProjectPath: boolean;
	supportsImages: boolean;
	acceptsApiProviderEndpoints: boolean;
	supportedProtocols: ApiProtocol[];
	authLoginSupported: boolean;
	supportedPermissionModes: PermissionMode[];
	supportedThinkingModes: ThinkingMode[];
	settings: AgentSettingDescriptor[];
	defaultSettings: AgentSettingsEnvelope;
	defaultModel: string;
}

type AgentModels = Record<string, ModelOption[]>;
type AgentMetadataMap = Record<string, AgentMetadata>;

interface ModelCatalogSnapshot {
	agentModels: AgentModels;
	agentMetadata: AgentMetadataMap;
	apiProviderCatalog: ApiProviderCatalogEntry[];
	etag: string | null;
	lastFetchedAt: number | null;
	lastValidatedAt: number | null;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const VALIDATION_RETRY_MS = 30_000;

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
		protocol:
			maybe.protocol === 'openai-compatible' || maybe.protocol === 'anthropic-messages'
				? (maybe.protocol as ApiProtocol)
				: undefined,
	};
}

function normalizeProtocols(value: unknown): ApiProtocol[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(p): p is ApiProtocol => p === 'openai-compatible' || p === 'anthropic-messages',
	);
}

function normalizePermissionModes(value: unknown): PermissionMode[] {
	return Array.isArray(value) ? value.filter(isPermissionMode) : [];
}

function normalizeThinkingModes(value: unknown): ThinkingMode[] {
	return Array.isArray(value) ? value.filter(isThinkingMode) : [];
}

function normalizeSettingDescriptors(value: unknown): AgentSettingDescriptor[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate): AgentSettingDescriptor[] => {
		if (!candidate || typeof candidate !== 'object') return [];
		const descriptor = candidate as Record<string, unknown>;
		if (typeof descriptor.key !== 'string' || typeof descriptor.label !== 'string') return [];
		const base = {
			key: descriptor.key,
			label: descriptor.label,
			...(isAgentSettingLabelKey(descriptor.labelKey) ? { labelKey: descriptor.labelKey } : {}),
		};
		if (descriptor.type === 'boolean' || descriptor.type === 'string') {
			return [{ ...base, type: descriptor.type }];
		}
		if (descriptor.type === 'credential-ref') {
			return typeof descriptor.credentialKind === 'string'
				? [{ ...base, type: descriptor.type, credentialKind: descriptor.credentialKind }]
				: [];
		}
		if (descriptor.type === 'enum') {
			if (!Array.isArray(descriptor.options)) return [];
			const options = descriptor.options.flatMap((candidateOption) => {
				if (!candidateOption || typeof candidateOption !== 'object') return [];
				const option = candidateOption as Record<string, unknown>;
				if (typeof option.value !== 'string' || typeof option.label !== 'string') return [];
				return [
					{
						value: option.value,
						label: option.label,
						...(isAgentSettingOptionLabelKey(option.labelKey) ? { labelKey: option.labelKey } : {}),
					},
				];
			});
			return options.length === descriptor.options.length
				? [{ ...base, type: descriptor.type, options }]
				: [];
		}
		return descriptor.type === 'number' &&
			typeof descriptor.min === 'number' &&
			typeof descriptor.max === 'number' &&
			typeof descriptor.step === 'number'
			? [
					{
						...base,
						type: descriptor.type,
						min: descriptor.min,
						max: descriptor.max,
						step: descriptor.step,
					},
				]
			: [];
	});
}

function normalizeDefaultSettings(
	agentId: string,
	value: unknown,
	fallback?: AgentSettingsEnvelope,
): AgentSettingsEnvelope {
	const parsed = parseAgentSettingsEnvelope(value);
	if (parsed?.ownerId === agentId) return parsed;
	if (fallback?.ownerId === agentId) return fallback;
	return createEmptyAgentSettings(agentId);
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
	const protocol =
		entry.protocol === 'openai-compatible' || entry.protocol === 'anthropic-messages'
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
			? entry.models
					.map((model) => normalizeModelOption(model))
					.filter((model): model is ModelOption => model !== null)
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

function normalizeAgentMetadataMap(agentMetadata: AgentMetadataMap): AgentMetadataMap {
	return Object.fromEntries(
		Object.entries(agentMetadata)
			.filter(([id]) => isAgentId(id))
			.map(([id, metadata]) => {
				return [
					id,
					{
						...metadata,
						supportsFork: metadata.supportsFork === true,
						supportsForkAtMessage: metadata.supportsForkAtMessage === true,
						supportsForkWhileRunning: metadata.supportsForkWhileRunning === true,
						supportsUpdateProjectPath: metadata.supportsUpdateProjectPath === true,
						label: metadata.label ?? id,
						supportedPermissionModes: normalizePermissionModes(metadata.supportedPermissionModes),
						supportedThinkingModes: normalizeThinkingModes(metadata.supportedThinkingModes),
						settings: normalizeSettingDescriptors(metadata.settings),
						defaultSettings: normalizeDefaultSettings(id, metadata.defaultSettings),
						defaultModel: metadata.defaultModel ?? '',
					},
				];
			}),
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
		if (!isAgentId(id)) continue;
		agentMetadata[id] = {
			id,
			label: typeof entry.label === 'string' ? entry.label : id,
			description: typeof entry.description === 'string' ? entry.description : undefined,
			supportsFork: Boolean(entry.supportsFork),
			supportsForkAtMessage: Boolean(entry.supportsForkAtMessage),
			supportsForkWhileRunning: Boolean(entry.supportsForkWhileRunning),
			supportsUpdateProjectPath: Boolean(entry.supportsUpdateProjectPath),
			supportsImages: Boolean(entry.supportsImages),
			acceptsApiProviderEndpoints: Boolean(entry.acceptsApiProviderEndpoints),
			supportedProtocols: normalizeProtocols(entry.supportedProtocols),
			authLoginSupported: Boolean(entry.authLoginSupported),
			supportedPermissionModes: normalizePermissionModes(entry.supportedPermissionModes),
			supportedThinkingModes: normalizeThinkingModes(entry.supportedThinkingModes),
			settings: normalizeSettingDescriptors(entry.settings),
			defaultSettings: normalizeDefaultSettings(id, entry.defaultSettings),
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

function emptySnapshot(): ModelCatalogSnapshot {
	return {
		agentModels: {},
		agentMetadata: {},
		apiProviderCatalog: [],
		etag: null,
		lastFetchedAt: null,
		lastValidatedAt: null,
	};
}

function normalizeSnapshot(parsed: Record<string, unknown>): ModelCatalogSnapshot {
	const agentModels =
		typeof parsed.agentModels === 'object' && parsed.agentModels !== null
			? (parsed.agentModels as AgentModels)
			: {};
	const agentMetadata = normalizeAgentMetadataMap(
		typeof parsed.agentMetadata === 'object' && parsed.agentMetadata !== null
			? (parsed.agentMetadata as AgentMetadataMap)
			: {},
	);
	const apiProviderCatalog = normalizeApiProviders(parsed.apiProviderCatalog);
	const lastFetchedAt = typeof parsed.lastFetchedAt === 'number' ? parsed.lastFetchedAt : null;
	const lastValidatedAt =
		typeof parsed.lastValidatedAt === 'number' ? parsed.lastValidatedAt : lastFetchedAt;

	return {
		agentModels,
		agentMetadata,
		apiProviderCatalog,
		etag: typeof parsed.etag === 'string' ? parsed.etag : null,
		lastFetchedAt,
		lastValidatedAt,
	};
}

function readPersisted(): ModelCatalogSnapshot {
	try {
		const raw =
			getLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog) ??
			getLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalogLegacy);
		if (!raw) return emptySnapshot();
		return normalizeSnapshot(JSON.parse(raw) as Record<string, unknown>);
	} catch {
		return emptySnapshot();
	}
}

function persist(snapshot: ModelCatalogSnapshot): void {
	setLocalStorageItem(LOCAL_STORAGE_KEYS.modelCatalog, JSON.stringify(snapshot));
}

interface CatalogApplyResult {
	agentModels: AgentModels;
	agentMetadata: AgentMetadataMap;
	apiProviderCatalog: ApiProviderCatalogEntry[];
}

function applyCatalogResult(
	catalogResult: NonNullable<ReturnType<typeof parseCatalogResponse>>,
): CatalogApplyResult {
	const agentModels = catalogResult.agentModels;
	const agentMetadata = normalizeAgentMetadataMap(catalogResult.agentMetadata);
	return {
		agentModels,
		agentMetadata,
		apiProviderCatalog: catalogResult.apiProviderCatalog,
	};
}

export class ModelCatalogStore {
	agentModels = $state<AgentModels>({});
	agentMetadata = $state<AgentMetadataMap>({});
	apiProviderCatalog = $state<ApiProviderCatalogEntry[]>([]);
	etag = $state<string | null>(null);
	lastFetchedAt = $state<number | null>(null);
	lastValidatedAt = $state<number | null>(null);
	isRefreshing = $state(false);
	error = $state<string | null>(null);
	version = $state(0);
	#syncPromise: Promise<void> | null = null;
	#lastSyncAttemptAt = 0;

	constructor() {
		this.hydrateFromStorage();
	}

	getAgents(): SessionAgentId[] {
		return Object.keys(this.agentMetadata).filter(isAgentId) as SessionAgentId[];
	}

	getSelectableAgents(): SessionAgentId[] {
		return this.getAgents();
	}

	getAgentMetadataList(): AgentMetadata[] {
		return Object.values(this.agentMetadata).filter((metadata) => isAgentId(metadata.id));
	}

	getAgent(id: string): AgentMetadata | null {
		if (!isAgentId(id)) return null;
		return this.agentMetadata[id] ?? null;
	}

	getAgentLabel(id: string): string {
		return agentLabelFor(id, this.agentMetadata[id]?.label ?? id);
	}

	getModels(agentId: SessionAgentId): ModelOption[] {
		if (!isAgentId(agentId)) return [];
		return this.agentModels[agentId] ?? [];
	}

	getDefaultModel(agentId: SessionAgentId): string {
		return this.agentMetadata[agentId]?.defaultModel || this.getModels(agentId)[0]?.value || '';
	}

	getAgentSettingsDescriptors(agentId: SessionAgentId): readonly AgentSettingDescriptor[] {
		return this.agentMetadata[agentId]?.settings ?? [];
	}

	getDefaultAgentSettings(agentId: SessionAgentId): AgentSettingsEnvelope {
		return this.agentMetadata[agentId]?.defaultSettings ?? createEmptyAgentSettings(agentId);
	}

	getPermissionModes(agentId: SessionAgentId): readonly PermissionMode[] {
		return this.agentMetadata[agentId]?.supportedPermissionModes ?? [];
	}

	getThinkingModes(agentId: SessionAgentId): readonly ThinkingMode[] {
		return this.agentMetadata[agentId]?.supportedThinkingModes ?? [];
	}

	getModel(agentId: SessionAgentId, model: string): ModelOption | null {
		return (
			this.getModels(agentId).find((entry) => entry.value === model || entry.rawModel === model) ??
			null
		);
	}

	getModelForSelection(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): ModelOption | null {
		const models = this.getModels(agentId);
		if (modelEndpointId) {
			const matchedEndpointModel = models.find(
				(entry) =>
					entry.endpointId === modelEndpointId &&
					(entry.value === model || entry.rawModel === model),
			);
			if (matchedEndpointModel) return matchedEndpointModel;
		}
		return models.find((entry) => entry.value === model || entry.rawModel === model) ?? null;
	}

	supportsFork(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsFork ?? false;
	}

	supportsForkAtMessage(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsForkAtMessage ?? false;
	}

	supportsForkWhileRunning(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsForkWhileRunning ?? false;
	}

	supportsUpdateProjectPath(agentId: SessionAgentId): boolean {
		if (!isAgentId(agentId)) return false;
		return this.agentMetadata[agentId]?.supportsUpdateProjectPath ?? false;
	}

	supportsImages(
		agentId: SessionAgentId,
		model?: string,
		modelEndpointId?: string | null,
	): boolean {
		if (!isAgentId(agentId)) return false;
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

	selectionFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): {
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

	selectionValueFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): string {
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

	hydrateFromStorage(): void {
		const snapshot = readPersisted();
		this.agentModels = snapshot.agentModels;
		this.agentMetadata = snapshot.agentMetadata;
		this.apiProviderCatalog = snapshot.apiProviderCatalog;
		this.etag = snapshot.etag;
		this.lastFetchedAt = snapshot.lastFetchedAt;
		this.lastValidatedAt = snapshot.lastValidatedAt;
		this.version += 1;
	}

	async refreshIfStale(_ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
		await this.syncWithServer();
	}

	isStale(ttlMs: number = DEFAULT_TTL_MS): boolean {
		const checkedAt = this.lastValidatedAt ?? this.lastFetchedAt;
		if (checkedAt === null) return true;
		return Date.now() - checkedAt >= ttlMs;
	}

	async forceRefresh(): Promise<void> {
		await this.syncWithServer({ force: true });
	}

	async syncWithServer(options: { force?: boolean } = {}): Promise<void> {
		const now = Date.now();
		if (this.#syncPromise) return this.#syncPromise;
		if (!options.force && now - this.#lastSyncAttemptAt < VALIDATION_RETRY_MS) return;

		this.#lastSyncAttemptAt = now;
		this.#syncPromise = this.#syncWithServer(options).finally(() => {
			this.#syncPromise = null;
		});
		return this.#syncPromise;
	}

	async #syncWithServer(options: { force?: boolean }): Promise<void> {
		this.isRefreshing = true;
		this.error = null;

		try {
			const response = await this.#fetchCatalogResponse(options);
			const responseEtag = response.headers?.get?.('etag') ?? null;

			if (response.status === 304) {
				this.etag = responseEtag ?? this.etag;
				this.lastValidatedAt = Date.now();
				this.#persistCurrentSnapshot();
				return;
			}

			if (!response.ok) {
				throw new Error(`Failed to fetch model catalog: ${response.status}`);
			}
			const data = (await response.json()) as ModelCatalogResponse;

			const catalogResult = parseCatalogResponse(data);
			if (catalogResult && Object.keys(catalogResult.agentMetadata).length > 0) {
				const applied = applyCatalogResult(catalogResult);
				this.agentModels = applied.agentModels;
				this.agentMetadata = applied.agentMetadata;
				this.apiProviderCatalog = applied.apiProviderCatalog;
			} else {
				throw new Error('Model catalog response is invalid');
			}

			const now = Date.now();
			this.etag = responseEtag;
			this.lastFetchedAt = now;
			this.lastValidatedAt = now;
			persist(this.#currentSnapshot());
			this.version += 1;
		} catch (error) {
			this.error = error instanceof Error ? error.message : 'Unknown error';
		} finally {
			this.isRefreshing = false;
		}
	}

	#fetchCatalogResponse(options: { force?: boolean }): Promise<Response> {
		if (!options.force && this.etag) {
			return apiFetch('/api/v1/models', {
				headers: {
					'If-None-Match': this.etag,
				},
			});
		}
		return apiFetch('/api/v1/models');
	}

	#currentSnapshot(): ModelCatalogSnapshot {
		return {
			agentModels: this.agentModels,
			agentMetadata: this.agentMetadata,
			apiProviderCatalog: this.apiProviderCatalog,
			etag: this.etag,
			lastFetchedAt: this.lastFetchedAt,
			lastValidatedAt: this.lastValidatedAt,
		};
	}

	#persistCurrentSnapshot(): void {
		persist(this.#currentSnapshot());
		this.version += 1;
	}
}

export function createModelCatalogStore(): ModelCatalogStore {
	return new ModelCatalogStore();
}
