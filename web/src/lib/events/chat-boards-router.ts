import type { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub.js';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import { ChatBoardsInvalidatedMessage, parseServerWsMessage } from '$shared/ws-events';

export class ChatBoardsRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsMessageLog,
		private readonly invalidations: Pick<ChatBoardInvalidationHub, 'publish'>,
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			if (message.data.type !== 'chat-boards-invalidated') continue;
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
