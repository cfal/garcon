// Coordinates chat-list navigation signals.
import { createActionSignal } from '$lib/utils/action-signal';

export class NavigationStore {
	#navigateChatAbove = createActionSignal();
	#navigateChatBelow = createActionSignal();

	onNavigateChatAboveRequested(cb: () => void): () => void {
		return this.#navigateChatAbove.subscribe(cb);
	}

	onNavigateChatBelowRequested(cb: () => void): () => void {
		return this.#navigateChatBelow.subscribe(cb);
	}

	/** Requests navigation to the chat above the currently selected one. */
	requestNavigateChatAbove(): void {
		this.#navigateChatAbove.emit();
	}

	/** Requests navigation to the chat below the currently selected one. */
	requestNavigateChatBelow(): void {
		this.#navigateChatBelow.emit();
	}
}

export function createNavigationStore(): NavigationStore {
	return new NavigationStore();
}
