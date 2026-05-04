import { apiFetch } from '$lib/api/client.js';
import type { SessionProvider } from '$lib/types/app';
import { CLAUDE_MODELS, CODEX_MODELS, AMP_MODELS, FACTORY_MODELS } from '$shared/models';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
	DIRECT_OPENAI_COMPATIBLE_HARNESS_ID,
	isApiProviderTemplateId,
	isEndpointOnlyHarnessId,
	isVisibleHarnessId,
	type ApiProtocol,
	type ApiProviderCatalogEntry,
	type ApiProviderEndpointCatalogEntry,
	type ApiProviderTemplateId,
	type ModelDiscoveryKind,
} from '$shared/providers';

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

export interface HarnessMetadata {
	id: string;
	label: string;
	description?: string;
	supportsFork: boolean;
	supportsImages: boolean;
	acceptsApiProviderEndpoints: boolean;
	supportedProtocols: ApiProtocol[];
	defaultModel: string;
}

type HarnessModels = Record<string, ModelOption[]>;
type HarnessMetadataMap = Record<string, HarnessMetadata>;

interface ModelCatalogSnapshot {
	harnessModels: HarnessModels;
	harnessMetadata: HarnessMetadataMap;
	apiProviderCatalog: ApiProviderCatalogEntry[];
	lastFetchedAt: number | null;
}

const STORAGE_KEY = 'pref_model_catalog';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

const STATIC_FALLBACKS: HarnessModels = {
	claude: CLAUDE_MODELS.OPTIONS,
	codex: CODEX_MODELS.OPTIONS,
	opencode: [],
	amp: AMP_MODELS.OPTIONS,
	factory: FACTORY_MODELS.OPTIONS,
	[DIRECT_OPENAI_COMPATIBLE_HARNESS_ID]: [],
	[DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID]: [],
};

const STATIC_HARNESS_METADATA: HarnessMetadataMap = {
	claude: { id: 'claude', label: 'Claude', supportsFork: true, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['anthropic-messages'], defaultModel: CLAUDE_MODELS.DEFAULT },
	codex: { id: 'codex', label: 'Codex', supportsFork: true, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-chat-completions'], defaultModel: CODEX_MODELS.DEFAULT },
	opencode: { id: 'opencode', label: 'OpenCode', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], defaultModel: '' },
	amp: { id: 'amp', label: 'Amp', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], defaultModel: AMP_MODELS.DEFAULT },
	factory: { id: 'factory', label: 'Factory', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], defaultModel: FACTORY_MODELS.DEFAULT },
	[DIRECT_OPENAI_COMPATIBLE_HARNESS_ID]: { id: DIRECT_OPENAI_COMPATIBLE_HARNESS_ID, label: 'Direct Chat (OpenAI)', supportsFork: false, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-chat-completions'], defaultModel: '' },
	[DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID]: { id: DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID, label: 'Direct Chat (Anthropic)', supportsFork: false, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['anthropic-messages'], defaultModel: '' },
};

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
		protocol: maybe.protocol === 'openai-chat-completions' || maybe.protocol === 'anthropic-messages'
			? maybe.protocol as ApiProtocol
			: undefined,
	};
}

function normalizeProtocols(value: unknown): ApiProtocol[] {
	if (!Array.isArray(value)) return [];
	return value.filter((p): p is ApiProtocol => p === 'openai-chat-completions' || p === 'anthropic-messages');
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

function normalizeApiProviderEndpoint(value: unknown): ApiProviderEndpointCatalogEntry | null {
	if (!value || typeof value !== 'object') return null;
	const entry = value as Record<string, unknown>;
	const protocol = entry.protocol === 'openai-chat-completions' || entry.protocol === 'anthropic-messages'
		? entry.protocol
		: null;
	if (
		typeof entry.id !== 'string' ||
		!protocol ||
		typeof entry.baseUrl !== 'string' ||
		!Array.isArray(entry.exposeTo) ||
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
		exposeTo: entry.exposeTo.filter((target): target is string => typeof target === 'string'),
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

function mergeWithFallbacks(models: HarnessModels): HarnessModels {
	const result: HarnessModels = {
		claude: mergeStaticModels(models.claude, STATIC_FALLBACKS.claude!),
		codex: mergeStaticModels(models.codex, STATIC_FALLBACKS.codex!),
			amp: models.amp?.length ? models.amp : STATIC_FALLBACKS.amp!,
			factory: mergeStaticModels(models.factory, STATIC_FALLBACKS.factory!),
			opencode: models.opencode?.length ? models.opencode : [],
			[DIRECT_OPENAI_COMPATIBLE_HARNESS_ID]: models[DIRECT_OPENAI_COMPATIBLE_HARNESS_ID]?.length ? models[DIRECT_OPENAI_COMPATIBLE_HARNESS_ID] : [],
			[DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID]: models[DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID]?.length ? models[DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID] : [],
		};
	for (const [key, value] of Object.entries(models)) {
		if (!(key in result) && value?.length && isVisibleHarnessId(key)) {
			result[key] = value;
		}
	}
	return result;
}

function filterVisibleHarnessMetadata(harnessMetadata: HarnessMetadataMap): HarnessMetadataMap {
	return Object.fromEntries(
		Object.entries(harnessMetadata).filter(([id]) => isVisibleHarnessId(id))
	);
}

function parseCatalogResponse(data: unknown): {
	harnessModels: HarnessModels;
	harnessMetadata: HarnessMetadataMap;
	apiProviderCatalog: ApiProviderCatalogEntry[];
} | null {
	if (!data || typeof data !== 'object') return null;
	const root = data as Record<string, unknown>;
	const catalog = root.catalog;
	if (!catalog || typeof catalog !== 'object') return null;
	const inner = catalog as Record<string, unknown>;
	if (!Array.isArray(inner.harnesses)) return null;

	const harnessModels: HarnessModels = {};
	const harnessMetadata: HarnessMetadataMap = {};

	for (const entry of inner.harnesses as Array<Record<string, unknown>>) {
		if (typeof entry.id !== 'string') continue;

		const id = entry.id;
		if (!isVisibleHarnessId(id)) continue;
		harnessMetadata[id] = {
			id,
			label: typeof entry.label === 'string' ? entry.label : id,
			description: typeof entry.description === 'string' ? entry.description : undefined,
			supportsFork: Boolean(entry.supportsFork),
			supportsImages: Boolean(entry.supportsImages),
			acceptsApiProviderEndpoints: Boolean(entry.acceptsApiProviderEndpoints),
			supportedProtocols: normalizeProtocols(entry.supportedProtocols),
			defaultModel: typeof entry.defaultModel === 'string' ? entry.defaultModel : '',
		};

		if (Array.isArray(entry.models)) {
			harnessModels[id] = entry.models
				.map((m) => normalizeModelOption(m))
				.filter((m): m is ModelOption => m !== null);
		}
	}

	return {
		harnessModels,
		harnessMetadata,
		apiProviderCatalog: normalizeApiProviders(inner.apiProviders),
	};
}

function readPersisted(): ModelCatalogSnapshot {
	if (typeof window === 'undefined') {
		return {
			harnessModels: { ...STATIC_FALLBACKS },
			harnessMetadata: { ...STATIC_HARNESS_METADATA },
			apiProviderCatalog: [],
			lastFetchedAt: null,
		};
	}

	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return {
				harnessModels: { ...STATIC_FALLBACKS },
				harnessMetadata: { ...STATIC_HARNESS_METADATA },
				apiProviderCatalog: [],
				lastFetchedAt: null,
			};
		}
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const harnessModels = mergeWithFallbacks(
			typeof parsed.harnessModels === 'object' && parsed.harnessModels !== null
				? parsed.harnessModels as HarnessModels
				: {},
		);
		const harnessMetadata = filterVisibleHarnessMetadata(
				typeof parsed.harnessMetadata === 'object' && parsed.harnessMetadata !== null
					? { ...STATIC_HARNESS_METADATA, ...(parsed.harnessMetadata as HarnessMetadataMap) }
					: { ...STATIC_HARNESS_METADATA }
		);
		const apiProviderCatalog = normalizeApiProviders(parsed.apiProviderCatalog);
		const lastFetchedAt =
			typeof parsed.lastFetchedAt === 'number' ? parsed.lastFetchedAt : null;
		return { harnessModels, harnessMetadata, apiProviderCatalog, lastFetchedAt };
	} catch {
		return {
			harnessModels: { ...STATIC_FALLBACKS },
			harnessMetadata: { ...STATIC_HARNESS_METADATA },
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

export class ModelCatalogStore {
	harnessModels = $state<HarnessModels>({ ...STATIC_FALLBACKS });
	harnessMetadata = $state<HarnessMetadataMap>({ ...STATIC_HARNESS_METADATA });
	apiProviderCatalog = $state<ApiProviderCatalogEntry[]>([]);
	lastFetchedAt = $state<number | null>(null);
	isRefreshing = $state(false);
	error = $state<string | null>(null);
	version = $state(0);

	constructor() {
		this.hydrateFromStorage();
	}

	getHarnesses(): SessionProvider[] {
		return Object.keys(this.harnessMetadata).filter(isVisibleHarnessId) as SessionProvider[];
	}

	getSelectableHarnesses(): SessionProvider[] {
		return this.getHarnesses().filter((harnessId) => {
			if (!isEndpointOnlyHarnessId(harnessId)) return true;
			return this.getModels(harnessId as SessionProvider).length > 0;
		}) as SessionProvider[];
	}

	getHarnessMetadataList(): HarnessMetadata[] {
		return Object.values(this.harnessMetadata)
			.filter((metadata) => isVisibleHarnessId(metadata.id));
	}

	getHarness(id: string): HarnessMetadata | null {
		if (!isVisibleHarnessId(id)) return null;
		return this.harnessMetadata[id] ?? null;
	}

	getHarnessLabel(id: string): string {
		return this.harnessMetadata[id]?.label ?? id;
	}

	getModels(harnessId: SessionProvider): ModelOption[] {
		if (!isVisibleHarnessId(harnessId)) return [];
		return this.harnessModels[harnessId] ?? [];
	}

	getDefaultModel(harnessId: SessionProvider): string {
		return this.harnessMetadata[harnessId]?.defaultModel
			|| this.getModels(harnessId)[0]?.value
			|| '';
	}

	getModel(harnessId: SessionProvider, model: string): ModelOption | null {
		return this.getModels(harnessId).find((entry) =>
			entry.value === model || entry.rawModel === model
		) ?? null;
	}

	getModelForSelection(
		harnessId: SessionProvider,
		model: string,
		modelEndpointId?: string | null,
	): ModelOption | null {
		const models = this.getModels(harnessId);
		if (modelEndpointId) {
			const matchedEndpointModel = models.find((entry) =>
				entry.endpointId === modelEndpointId && (entry.value === model || entry.rawModel === model)
			);
			if (matchedEndpointModel) return matchedEndpointModel;
		}
		return models.find((entry) => entry.value === model || entry.rawModel === model) ?? null;
	}

	supportsFork(harnessId: SessionProvider): boolean {
		if (!isVisibleHarnessId(harnessId)) return false;
		return this.harnessMetadata[harnessId]?.supportsFork ?? false;
	}

	supportsImages(harnessId: SessionProvider, model?: string, modelEndpointId?: string | null): boolean {
		if (!isVisibleHarnessId(harnessId)) return false;
		if (model) {
			const selected = this.getModelForSelection(harnessId, model, modelEndpointId);
			if (selected && typeof selected.supportsImages === 'boolean') {
				return selected.supportsImages;
			}
		}
		return this.harnessMetadata[harnessId]?.supportsImages ?? false;
	}

	isLocalModel(harnessId: SessionProvider, model: string, modelEndpointId?: string | null): boolean {
		return this.getModelForSelection(harnessId, model, modelEndpointId)?.isLocal === true;
	}

	selectionFor(harnessId: SessionProvider, model: string, modelEndpointId?: string | null): {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	} {
		const selected = this.getModelForSelection(harnessId, model, modelEndpointId);
		return {
			model: selected?.rawModel ?? model,
			apiProviderId: selected?.apiProviderId ?? null,
			modelEndpointId: selected?.endpointId ?? null,
			modelProtocol: selected?.protocol ?? null,
		};
	}

	selectionValueFor(harnessId: SessionProvider, model: string, modelEndpointId?: string | null): string {
		return this.getModelForSelection(harnessId, model, modelEndpointId)?.value ?? model;
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
		this.harnessModels = snapshot.harnessModels;
		this.harnessMetadata = snapshot.harnessMetadata;
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
			if (catalogResult && Object.keys(catalogResult.harnessModels).length > 0) {
				this.harnessModels = mergeWithFallbacks(catalogResult.harnessModels);
				this.harnessMetadata = filterVisibleHarnessMetadata({ ...STATIC_HARNESS_METADATA, ...catalogResult.harnessMetadata });
				this.apiProviderCatalog = catalogResult.apiProviderCatalog;
			} else {
				throw new Error('Model catalog response is invalid');
			}

			this.lastFetchedAt = Date.now();
			persist({
				harnessModels: this.harnessModels,
				harnessMetadata: this.harnessMetadata,
				apiProviderCatalog: this.apiProviderCatalog,
				lastFetchedAt: this.lastFetchedAt,
			});
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
