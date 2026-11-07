import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import * as m from '$lib/paraglide/messages.js';

type SearchSettings = Pick<RemoteSettingsStore, 'snapshot' | 'ensureLoaded' | 'update'>;

export class OnboardingTranscriptSearchState {
	#settings: SearchSettings;
	#active = false;
	#initialized = false;
	#requestedEnabled = true;
	isSaving = $state(false);
	error = $state<string | null>(null);

	constructor(settings: SearchSettings) {
		this.#settings = settings;
	}

	get enabled(): boolean {
		return this.#settings.snapshot?.features.transcriptSearch.enabled === true;
	}

	activate(): void {
		this.#active = true;
		if (!this.#initialized) void this.setEnabled(true);
	}

	deactivate(): void {
		this.#active = false;
	}

	retry(): void {
		void this.setEnabled(this.#requestedEnabled);
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (this.isSaving) return;
		this.isSaving = true;
		this.error = null;
		this.#requestedEnabled = enabled;
		try {
			await this.#settings.ensureLoaded();
			if (!this.#active) return;
			// Retains an explicit opt-out when the page is revisited in this wizard.
			this.#initialized = true;
			if (this.enabled !== enabled) {
				await this.#settings.update({ features: { transcriptSearch: { enabled } } });
			}
		} catch {
			this.error = m.onboarding_search_error();
		} finally {
			this.isSaving = false;
		}
	}
}
