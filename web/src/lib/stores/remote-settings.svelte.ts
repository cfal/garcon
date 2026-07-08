// Canonical client-side owner of server-backed settings. Provides an
// explicit load state so consumers can show loading UI instead of
// rendering guessed defaults.

import { untrack } from 'svelte';
import type { RemoteSettingsSnapshot, UpdateRemoteSettingsInput } from '$shared/settings';
import { getRemoteSettings, updateRemoteSettings } from '$lib/api/settings.js';

export type RemoteSettingsStatus = 'idle' | 'loading' | 'ready' | 'error';

export class RemoteSettingsStore {
	status = $state<RemoteSettingsStatus>('idle');
	isRefreshing = $state(false);
	error = $state<string | null>(null);
	snapshot = $state<RemoteSettingsSnapshot | null>(null);
	loadedAt = $state<number | null>(null);

	#loadPromise: Promise<RemoteSettingsSnapshot> | null = null;
	#snapshotRevision = 0;

	get hasSnapshot(): boolean {
		return this.snapshot !== null;
	}

	async ensureLoaded(): Promise<RemoteSettingsSnapshot> {
		if (this.snapshot) return this.snapshot;
		return this.refresh({ initial: true });
	}

	async ensureLoadedInBackground(): Promise<void> {
		// Runs outside effect tracking so background hydration does not turn
		// callers into subscribers of refresh-internal store churn.
		await untrack(() =>
			this.#runInBackground(() => {
				if (this.snapshot) return Promise.resolve(this.snapshot);
				return this.refresh({ initial: true });
			}),
		);
	}

	async refresh(options?: { initial?: boolean }): Promise<RemoteSettingsSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;

		const initial = options?.initial === true || this.snapshot === null;
		if (initial) {
			this.status = 'loading';
		} else {
			this.isRefreshing = true;
		}
		this.error = null;

		this.#loadPromise = (async () => {
			try {
				const settings = await getRemoteSettings();
				return this.applySnapshot(settings);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Failed to load remote settings';
				this.error = message;
				if (!this.snapshot) {
					this.status = 'error';
				}
				throw error;
			} finally {
				this.isRefreshing = false;
				this.#loadPromise = null;
			}
		})();

		return this.#loadPromise;
	}

	async refreshInBackground(): Promise<void> {
		await untrack(() => this.#runInBackground(() => this.refresh()));
	}

	async update(patch: UpdateRemoteSettingsInput): Promise<RemoteSettingsSnapshot> {
		this.error = null;
		const response = await updateRemoteSettings(patch);
		return this.applySnapshot(response.settings);
	}

	applySnapshot(snap: RemoteSettingsSnapshot): RemoteSettingsSnapshot {
		if (this.snapshot && snap.version < this.snapshot.version) {
			return this.snapshot;
		}
		this.snapshot = snap;
		this.loadedAt = Date.now();
		this.status = 'ready';
		this.error = null;
		this.#snapshotRevision += 1;
		return snap;
	}

	applyOptimisticSnapshot(snap: RemoteSettingsSnapshot): () => void {
		const optimisticRevision = this.#snapshotRevision + 1;
		const previousSnapshot = this.snapshot;
		const previousStatus = this.status;
		const previousLoadedAt = this.loadedAt;
		const previousError = this.error;

		this.snapshot = snap;
		this.loadedAt = Date.now();
		this.status = 'ready';
		this.error = null;
		this.#snapshotRevision = optimisticRevision;

		return () => {
			if (this.#snapshotRevision !== optimisticRevision) return;
			this.snapshot = previousSnapshot;
			this.loadedAt = previousLoadedAt;
			this.status = previousStatus;
			this.error = previousError;
			this.#snapshotRevision += 1;
		};
	}

	async #runInBackground(load: () => Promise<RemoteSettingsSnapshot>): Promise<void> {
		try {
			await load();
		} catch {
			// Keeps the background refresh non-fatal because the store already
			// exposes the error state for reactive consumers.
		}
	}
}

export function createRemoteSettingsStore(): RemoteSettingsStore {
	return new RemoteSettingsStore();
}
