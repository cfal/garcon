export type ConversationFeedRetentionReason = 'focus' | 'transient' | 'selection' | 'target';

interface TransientRegistration {
	key: string;
	close: () => void;
	release: () => void;
}

export class ConversationFeedRetentionState {
	#leases = new Map<string, Map<ConversationFeedRetentionReason, Set<symbol>>>();
	#transients = new Map<symbol, TransientRegistration>();
	#retainedKeys = $state<string[]>([]);

	get retainedKeys(): readonly string[] {
		return this.#retainedKeys;
	}

	acquire(key: string, reason: ConversationFeedRetentionReason): () => void {
		const token = Symbol(reason);
		let byReason = this.#leases.get(key);
		const keyWasRetained = Boolean(byReason);
		if (!byReason) {
			byReason = new Map();
			this.#leases.set(key, byReason);
		}
		let tokens = byReason.get(reason);
		if (!tokens) {
			tokens = new Set();
			byReason.set(reason, tokens);
		}
		tokens.add(token);
		if (!keyWasRetained) this.#publishKeys();

		let released = false;
		return () => {
			if (released) return;
			released = true;
			const currentReasons = this.#leases.get(key);
			const currentTokens = currentReasons?.get(reason);
			currentTokens?.delete(token);
			if (currentTokens?.size === 0) currentReasons?.delete(reason);
			if (currentReasons?.size === 0) {
				this.#leases.delete(key);
				this.#publishKeys();
			}
		};
	}

	acquireTransient(key: string, close: () => void): () => void {
		const token = Symbol('transient');
		const releaseLease = this.acquire(key, 'transient');
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			this.#transients.delete(token);
			releaseLease();
		};
		this.#transients.set(token, { key, close, release });
		return release;
	}

	closeAllTransients(): void {
		const registrations = [...this.#transients.values()];
		for (const registration of registrations) {
			try {
				registration.close();
			} catch (error) {
				console.error('Failed to close retained Chat UI', error);
			} finally {
				registration.release();
			}
		}
	}

	prune(validKeys: Iterable<string>): void {
		const valid = new Set(validKeys);
		const removed = [...this.#leases.keys()].filter((key) => !valid.has(key));
		if (removed.length === 0) return;

		const removedKeys = new Set(removed);
		for (const registration of [...this.#transients.values()]) {
			if (!removedKeys.has(registration.key)) continue;
			try {
				registration.close();
			} catch (error) {
				console.error('Failed to close retained Chat UI', error);
			} finally {
				registration.release();
			}
		}
		for (const key of removed) this.#leases.delete(key);
		this.#publishKeys();
	}

	clear(): void {
		this.closeAllTransients();
		this.#transients.clear();
		if (this.#leases.size === 0) return;
		this.#leases.clear();
		this.#publishKeys();
	}

	observeSelection(options: {
		get root(): HTMLElement | null;
		get visible(): boolean;
	}): () => void {
		if (typeof document === 'undefined') return () => {};
		let retainedKey: string | null = null;
		let releaseSelection: (() => void) | null = null;

		const sync = (): void => {
			const root = options.root;
			const selection = document.getSelection();
			const anchorElement = elementForNode(selection?.anchorNode ?? null);
			const wrapper =
				options.visible && root && selection && !selection.isCollapsed && anchorElement
					? anchorElement.closest<HTMLElement>('[data-chat-virtual-item]')
					: null;
			const nextKey = wrapper && root?.contains(wrapper) ? wrapper.dataset.chatVirtualItem : null;
			if (nextKey === retainedKey) return;
			releaseSelection?.();
			releaseSelection = null;
			retainedKey = nextKey ?? null;
			if (retainedKey) releaseSelection = this.acquire(retainedKey, 'selection');
		};

		document.addEventListener('selectionchange', sync);
		sync();
		return () => {
			document.removeEventListener('selectionchange', sync);
			releaseSelection?.();
		};
	}

	#publishKeys(): void {
		this.#retainedKeys = [...this.#leases.keys()];
	}
}

function elementForNode(node: Node | null): Element | null {
	if (!node) return null;
	return node instanceof Element ? node : node.parentElement;
}
