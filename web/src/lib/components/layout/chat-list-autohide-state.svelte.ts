interface ChatListAutohideOptions {
	readonly active: boolean;
}

export class ChatListAutohideState {
	#revealed = $state(false);
	readonly #options: ChatListAutohideOptions;

	constructor(options: ChatListAutohideOptions) {
		this.#options = options;
	}

	get active(): boolean {
		return this.#options.active;
	}

	get revealed(): boolean {
		return this.active && this.#revealed;
	}

	get collapsed(): boolean {
		return this.active && !this.#revealed;
	}

	reveal(): void {
		if (this.active) this.#revealed = true;
	}

	collapse(): void {
		this.#revealed = false;
	}

	collapseUnlessEngaged(container: HTMLElement | null): void {
		if (!this.active) return;
		if (container?.contains(document.activeElement)) return;
		if (container?.querySelector('[aria-expanded="true"]')) return;
		this.collapse();
	}
}
