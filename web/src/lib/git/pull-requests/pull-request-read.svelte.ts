// One independently refreshable part of the selected pull request. The shown
// value survives a refresh, so a failed refresh leaves the last good value in
// place beside its error instead of blanking the view or implying success.

import { errorMessage } from '$lib/utils/error-message.js';

export type PullRequestReadOutcome<T> =
	| { readonly kind: 'loaded'; readonly value: T }
	| { readonly kind: 'failed'; readonly error: unknown }
	| { readonly kind: 'superseded' };

export class PullRequestReadState<T> {
	// Raw because diffs are large and never mutated in place.
	value = $state.raw<T | null>(null);
	isLoading = $state(false);
	error = $state<string | null>(null);
	readonly #fallbackMessage: () => string;
	// The input identity of the shown value, or of the latest attempt while it loads or after it failed.
	#key: string | null = null;
	#controller: AbortController | null = null;

	constructor(fallbackMessage: () => string) {
		this.#fallbackMessage = fallbackMessage;
	}

	get key(): string | null {
		return this.#key;
	}

	// Reads `key` unless it is already shown, loading, or failed; a failure waits for an explicit retry.
	ensure(
		key: string,
		read: (signal: AbortSignal) => Promise<T>,
	): Promise<PullRequestReadOutcome<T>> | null {
		return key === this.#key ? null : this.load(key, read);
	}

	async load(
		key: string,
		read: (signal: AbortSignal) => Promise<T>,
	): Promise<PullRequestReadOutcome<T>> {
		this.#controller?.abort();
		const controller = new AbortController();
		this.#controller = controller;
		this.#key = key;
		this.isLoading = true;
		this.error = null;
		try {
			const value = await read(controller.signal);
			if (this.#controller !== controller) return { kind: 'superseded' };
			this.value = value;
			return { kind: 'loaded', value };
		} catch (error) {
			if (this.#controller !== controller) return { kind: 'superseded' };
			this.error = errorMessage(error, this.#fallbackMessage());
			return { kind: 'failed', error };
		} finally {
			if (this.#controller === controller) {
				this.#controller = null;
				this.isLoading = false;
			}
		}
	}

	// Lets the next `ensure` repeat a failed read; a shown or loading read is untouched.
	forgetFailure(): void {
		if (this.error !== null && !this.isLoading) this.#key = null;
	}

	reset(): void {
		this.#controller?.abort();
		this.#controller = null;
		this.#key = null;
		this.value = null;
		this.error = null;
		this.isLoading = false;
	}
}
