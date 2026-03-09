import { apiFetch } from '$lib/api/client.js';
import type { SessionProvider } from '$lib/types/app';
import { CLAUDE_MODELS, CODEX_MODELS, AMP_MODELS } from '$shared/models';
import { PROVIDERS, PROVIDER_CAPABILITIES, type ProviderId } from '$shared/providers';

export interface ModelOption {
	value: string;
	label: string;
}

type ProviderModels = Partial<Record<SessionProvider, ModelOption[]>>;

type ProviderCapabilitiesMap = Partial<Record<SessionProvider, {
	supportsFork: boolean;
	supportsImages: boolean;
}>>;

interface ModelCatalogSnapshot {
	providerModels: ProviderModels;
	providerCapabilities: ProviderCapabilitiesMap;
	lastFetchedAt: number | null;
}

const STORAGE_KEY = 'pref_model_catalog';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

const STATIC_FALLBACKS: ProviderModels = {
	claude: CLAUDE_MODELS.OPTIONS,
	codex: CODEX_MODELS.OPTIONS,
	opencode: [],
	amp: AMP_MODELS.OPTIONS
};

// Default capabilities derived from the shared common contract. Used when
// the server response hasn't been parsed yet or lacks the catalog field.
const DEFAULT_CAPABILITIES: ProviderCapabilitiesMap = Object.fromEntries(
	PROVIDERS.map((id) => [id, { ...PROVIDER_CAPABILITIES[id] }])
) as ProviderCapabilitiesMap;

function normalizeModelOption(value: unknown): ModelOption | null {
	if (!value || typeof value !== 'object') return null;
	const maybe = value as Record<string, unknown>;
	if (typeof maybe.value !== 'string' || typeof maybe.label !== 'string') return null;
	return { value: maybe.value, label: maybe.label };
}

function normalizeProviderModels(value: unknown): ProviderModels {
	if (!value || typeof value !== 'object') return {};
	const source = value as Record<string, unknown>;
	const normalized: ProviderModels = {};
	for (const provider of PROVIDERS) {
		const rawOptions = source[provider];
		if (!Array.isArray(rawOptions)) continue;
		const options = rawOptions
			.map((option) => normalizeModelOption(option))
			.filter((option): option is ModelOption => option !== null);
		normalized[provider] = options;
	}
	return normalized;
}

// Ensures static models for claude/codex are always present in the result,
// even when a cached or server list is missing newly added entries.
function mergeStaticModels(remote: ModelOption[] | undefined, fallback: ModelOption[]): ModelOption[] {
	if (!remote?.length) return fallback;
	const seen = new Set(remote.map((m) => m.value));
	const missing = fallback.filter((m) => !seen.has(m.value));
	return missing.length ? [...remote, ...missing] : remote;
}

function mergeWithFallbacks(models: ProviderModels): ProviderModels {
	return {
		claude: mergeStaticModels(models.claude, STATIC_FALLBACKS.claude!),
		codex: mergeStaticModels(models.codex, STATIC_FALLBACKS.codex!),
		amp: mergeStaticModels(models.amp, STATIC_FALLBACKS.amp!),
		opencode: models.opencode?.length ? models.opencode : STATIC_FALLBACKS.opencode
	};
}

interface CatalogProviderEntry {
	id: string;
	supportsFork: boolean;
	supportsImages: boolean;
	models: unknown[];
}

// Extracts capabilities and models from the catalog.providers array when
// present in the API response, falling back to empty results otherwise.
function parseCatalogResponse(data: unknown): {
	providerModels: ProviderModels;
	providerCapabilities: ProviderCapabilitiesMap;
} | null {
	if (!data || typeof data !== 'object') return null;
	const root = data as Record<string, unknown>;
	const catalog = root.catalog;
	if (!catalog || typeof catalog !== 'object') return null;
	const inner = catalog as Record<string, unknown>;
	if (!Array.isArray(inner.providers)) return null;

	const providerModels: ProviderModels = {};
	const providerCapabilities: ProviderCapabilitiesMap = {};

	for (const entry of inner.providers as CatalogProviderEntry[]) {
		if (!entry || typeof entry.id !== 'string') continue;
		const id = entry.id as SessionProvider;
		if (!(PROVIDERS as readonly string[]).includes(id)) continue;

		providerCapabilities[id] = {
			supportsFork: Boolean(entry.supportsFork),
			supportsImages: Boolean(entry.supportsImages),
		};

		if (Array.isArray(entry.models)) {
			const models = entry.models
				.map((m) => normalizeModelOption(m))
				.filter((m): m is ModelOption => m !== null);
			providerModels[id] = models;
		}
	}

	return { providerModels, providerCapabilities };
}

function readPersisted(): ModelCatalogSnapshot {
	if (typeof window === 'undefined') {
		return { providerModels: { ...STATIC_FALLBACKS }, providerCapabilities: { ...DEFAULT_CAPABILITIES }, lastFetchedAt: null };
	}

	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return { providerModels: { ...STATIC_FALLBACKS }, providerCapabilities: { ...DEFAULT_CAPABILITIES }, lastFetchedAt: null };
		}
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const providerModels = mergeWithFallbacks(normalizeProviderModels(parsed.providerModels));
		const providerCapabilities = normalizeCapabilities(parsed.providerCapabilities);
		const lastFetchedAt =
			typeof parsed.lastFetchedAt === 'number' ? parsed.lastFetchedAt : null;
		return { providerModels, providerCapabilities, lastFetchedAt };
	} catch {
		return { providerModels: { ...STATIC_FALLBACKS }, providerCapabilities: { ...DEFAULT_CAPABILITIES }, lastFetchedAt: null };
	}
}

function normalizeCapabilities(value: unknown): ProviderCapabilitiesMap {
	if (!value || typeof value !== 'object') return { ...DEFAULT_CAPABILITIES };
	const source = value as Record<string, unknown>;
	const result: ProviderCapabilitiesMap = {};
	for (const provider of PROVIDERS) {
		const entry = source[provider];
		if (entry && typeof entry === 'object') {
			const e = entry as Record<string, unknown>;
			result[provider] = {
				supportsFork: typeof e.supportsFork === 'boolean' ? e.supportsFork : (DEFAULT_CAPABILITIES[provider]?.supportsFork ?? false),
				supportsImages: typeof e.supportsImages === 'boolean' ? e.supportsImages : (DEFAULT_CAPABILITIES[provider]?.supportsImages ?? false),
			};
		} else {
			result[provider] = DEFAULT_CAPABILITIES[provider] ? { ...DEFAULT_CAPABILITIES[provider]! } : { supportsFork: false, supportsImages: false };
		}
	}
	return result;
}

function persist(snapshot: ModelCatalogSnapshot): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
	} catch {
		// localStorage may be unavailable.
	}
}

export class ModelCatalogStore {
	providerModels = $state<ProviderModels>({ ...STATIC_FALLBACKS });
	providerCapabilities = $state<ProviderCapabilitiesMap>({ ...DEFAULT_CAPABILITIES });
	lastFetchedAt = $state<number | null>(null);
	isRefreshing = $state(false);
	error = $state<string | null>(null);
	version = $state(0);

	constructor() {
		this.hydrateFromStorage();
	}

	getProviders(): SessionProvider[] {
		return [...PROVIDERS] as SessionProvider[];
	}

	getModels(provider: SessionProvider): ModelOption[] {
		return this.providerModels[provider] ?? [];
	}

	getDefaultModel(provider: SessionProvider): string {
		if (provider === 'claude') return CLAUDE_MODELS.DEFAULT;
		if (provider === 'codex') return CODEX_MODELS.DEFAULT;
		if (provider === 'amp') return AMP_MODELS.DEFAULT;
		return this.getModels('opencode')[0]?.value ?? '';
	}

	supportsFork(provider: SessionProvider): boolean {
		return this.providerCapabilities[provider]?.supportsFork ?? false;
	}

	supportsImages(provider: SessionProvider): boolean {
		return this.providerCapabilities[provider]?.supportsImages ?? false;
	}

	hydrateFromStorage(): void {
		const snapshot = readPersisted();
		this.providerModels = snapshot.providerModels;
		this.providerCapabilities = snapshot.providerCapabilities;
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

			let providerModels: ProviderModels;
			let providerCapabilities: ProviderCapabilitiesMap;

			const catalogResult = parseCatalogResponse(data);
			if (catalogResult && Object.keys(catalogResult.providerModels).length > 0) {
				providerModels = mergeWithFallbacks(catalogResult.providerModels);
				providerCapabilities = catalogResult.providerCapabilities;
			} else {
				providerModels = mergeWithFallbacks(normalizeProviderModels(data));
				providerCapabilities = { ...DEFAULT_CAPABILITIES };
			}

			const lastFetchedAt = Date.now();
			this.providerModels = providerModels;
			this.providerCapabilities = providerCapabilities;
			this.lastFetchedAt = lastFetchedAt;
			persist({ providerModels, providerCapabilities, lastFetchedAt });
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
