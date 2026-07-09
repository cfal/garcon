import type { GhAvailabilityReason, GhStatusResponse } from '$shared/gh';
import { getGhStatus } from '$lib/api/gh.js';

export interface GhCapabilityContext {
	available: boolean;
	authenticated: boolean;
	reason: GhAvailabilityReason | null;
	login: string | null;
	host: string | null;
	isLoading: boolean;
	hasChecked: boolean;
	lastError: string | null;
	ensureChecked: () => Promise<void>;
	refresh: () => Promise<void>;
}

export class GhCapabilityStore implements GhCapabilityContext {
	#loadGeneration = 0;
	#startupChecked = false;
	#startupPromise: Promise<void> | null = null;

	available = $state(false);
	authenticated = $state(false);
	reason = $state<GhAvailabilityReason | null>(null);
	login = $state<string | null>(null);
	host = $state<string | null>(null);
	isLoading = $state(false);
	hasChecked = $state(false);
	lastError = $state<string | null>(null);

	async ensureChecked(): Promise<void> {
		if (this.#startupChecked) return;
		if (this.#startupPromise) return this.#startupPromise;

		this.#startupPromise = this.#load().finally(() => {
			this.#startupChecked = true;
			this.#startupPromise = null;
		});
		return this.#startupPromise;
	}

	async refresh(): Promise<void> {
		try {
			await this.#load();
		} finally {
			this.#startupChecked = true;
			this.#startupPromise = null;
		}
	}

	async #load(): Promise<void> {
		const generation = ++this.#loadGeneration;
		this.isLoading = true;
		this.lastError = null;

		try {
			const status = await getGhStatus();
			if (generation !== this.#loadGeneration) return;
			this.#applyStatus(status);
			this.hasChecked = true;
		} catch (error) {
			if (generation !== this.#loadGeneration) return;
			this.available = false;
			this.authenticated = false;
			this.reason = 'unknown';
			this.login = null;
			this.host = null;
			this.hasChecked = true;
			this.lastError =
				error instanceof Error ? error.message : 'Failed to check GitHub CLI status.';
		} finally {
			if (generation === this.#loadGeneration) this.isLoading = false;
		}
	}

	#applyStatus(status: GhStatusResponse): void {
		this.available = status.available;
		this.authenticated = status.authenticated;
		this.reason = status.reason;
		this.login = status.login ?? null;
		this.host = status.host ?? null;
	}
}

export function createGhCapabilityStore(): GhCapabilityStore {
	return new GhCapabilityStore();
}
