import type { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub.js';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';
import { ChatBoardsInvalidatedMessage, parseServerWsMessage } from '$shared/ws-events';

export class ChatBoardsRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsConnection,
		private readonly invalidations: Pick<ChatBoardInvalidationHub, 'publish'>,
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof ChatBoardsInvalidatedMessage) {
				this.invalidations.publish({
					kind: 'catalog',
					revision: parsed.revision,
					reason: parsed.reason,
				});
			}
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
