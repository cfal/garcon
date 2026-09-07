// A fork point the provider has not written to its native history yet can still be forked, by
// carrying the conversation over into a fresh session instead of branching the native one. That
// trade is the user's to make, so the refusal becomes a question rather than an error.
export class HandoffForkConfirmationState {
	#resolve: ((confirmed: boolean) => void) | null = $state(null);

	get isOpen(): boolean {
		return this.#resolve !== null;
	}

	// Resolves once the user answers. A second request supersedes the first, which is declined so
	// its caller never waits on a dialog the user can no longer see.
	ask(): Promise<boolean> {
		this.#settle(false);
		return new Promise<boolean>((resolve) => {
			this.#resolve = resolve;
		});
	}

	confirm(): void {
		this.#settle(true);
	}

	cancel(): void {
		this.#settle(false);
	}

	#settle(confirmed: boolean): void {
		const resolve = this.#resolve;
		this.#resolve = null;
		resolve?.(confirmed);
	}
}
