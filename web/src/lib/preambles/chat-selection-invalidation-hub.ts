// Per-chat selection invalidation hub. The WebSocket router publishes body-free
// `chat-preambles-invalidated` events here; an open selection editor subscribes
// for its captured target. No permanent all-chat cache exists.
import type { PreambleId } from '$shared/preambles';

export interface ChatPreambleInvalidation {
	readonly kind: 'selection';
	readonly chatId: string;
	readonly revision: number;
}

export interface ChatPreambleReconnect {
	readonly kind: 'reconnect';
}

export type ChatPreambleSelectionHubEvent = ChatPreambleInvalidation | ChatPreambleReconnect;

type Listener = (event: ChatPreambleSelectionHubEvent) => void;

export class ChatPreambleSelectionInvalidationHub {
	#listeners = new Set<Listener>();

	publish(event: ChatPreambleSelectionHubEvent): void {
		// A listener may unsubscribe or resubscribe synchronously (a clean
		// editor refreshes by reopening). Iterate a snapshot so a replacement
		// listener is never revisited within one dispatch.
		for (const listener of [...this.#listeners]) {
			listener(event);
		}
	}

	publishReconnect(): void {
		this.publish({ kind: 'reconnect' });
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

export function createChatPreambleSelectionInvalidationHub(): ChatPreambleSelectionInvalidationHub {
	return new ChatPreambleSelectionInvalidationHub();
}

export type { PreambleId };
