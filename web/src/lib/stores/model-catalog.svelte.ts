import { apiFetch } from '$lib/api/client.js';
import type { SessionProvider } from '$lib/types/app';
import { CLAUDE_MODELS, CODEX_MODELS } from '$shared/models';

export interface ModelOption {
	value: string;
	label: string;
}

type ProviderModels = Partial<Record<SessionProvider, ModelOption[]>>;

interface ModelCatalogSnapshot {
	providerModels: ProviderModels;
	lastFetchedAt: number | null;
}

const STORAGE_KEY = 'pref_model_catalog';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const PROVIDERS: SessionProvider[] = ['claude', 'codex', 'opencode'];

const STATIC_FALLBACKS: ProviderModels = {
	claude: CLAUDE_MODELS.OPTIONS,
	codex: CODEX_MODELS.OPTIONS,
	opencode: []
};

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

function mergeWithFallbacks(models: ProviderModels): ProviderModels {
	return {
		claude: models.claude?.length ? models.claude : STATIC_FALLBACKS.claude,
		codex: models.codex?.length ? models.codex : STATIC_FALLBACKS.codex,
		opencode: models.opencode?.length ? models.opencode : STATIC_FALLBACKS.opencode
	};
}

function readPersisted(): ModelCatalogSnapshot {
	if (typeof window === 'undefined') {
		return { providerModels: { ...STATIC_FALLBACKS }, lastFetchedAt: null };
	}

	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return { providerModels: { ...STATIC_FALLBACKS }, lastFetchedAt: null };
		}
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const providerModels = mergeWithFallbacks(normalizeProviderModels(parsed.providerModels));
		const lastFetchedAt =
			typeof parsed.lastFetchedAt === 'number' ? parsed.lastFetchedAt : null;
		return { providerModels, lastFetchedAt };
	} catch {
		return { providerModels: { ...STATIC_FALLBACKS }, lastFetchedAt: null };
	}
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
	lastFetchedAt = $state<number | null>(null);
	isRefreshing = $state(false);
	error = $state<string | null>(null);
	version = $state(0);

	constructor() {
		this.hydrateFromStorage();
	}

	getProviders(): SessionProvider[] {
		return PROVIDERS;
	}

	getModels(provider: SessionProvider): ModelOption[] {
		return this.providerModels[provider] ?? [];
	}

	getDefaultModel(provider: SessionProvider): string {
		if (provider === 'claude') return CLAUDE_MODELS.DEFAULT;
		if (provider === 'codex') return CODEX_MODELS.DEFAULT;
		return this.getModels('opencode')[0]?.value ?? '';
	}

	hydrateFromStorage(): void {
		const snapshot = readPersisted();
		this.providerModels = snapshot.providerModels;
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
			const providerModels = mergeWithFallbacks(normalizeProviderModels(data));
			const lastFetchedAt = Date.now();
			this.providerModels = providerModels;
			this.lastFetchedAt = lastFetchedAt;
			persist({ providerModels, lastFetchedAt });
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
