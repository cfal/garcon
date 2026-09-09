import type { ChatBoardInvalidationReason } from '$shared/chat-boards';

export type ChatBoardInvalidation =
	| {
			readonly kind: 'catalog';
			readonly revision: number;
			readonly reason: ChatBoardInvalidationReason;
	  }
	| { readonly kind: 'reconnect' };

export class ChatBoardInvalidationHub {
	readonly #listeners = new Set<(event: ChatBoardInvalidation) => void>();

	subscribe(listener: (event: ChatBoardInvalidation) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	publish(event: ChatBoardInvalidation): void {
		for (const listener of this.#listeners) listener(event);
	}

	publishReconnect(): void {
		this.publish({ kind: 'reconnect' });
	}
}

export function createChatBoardInvalidationHub(): ChatBoardInvalidationHub {
	return new ChatBoardInvalidationHub();
}
