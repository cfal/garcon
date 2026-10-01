import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import type { ChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub.js';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import {
	ChatPreamblesInvalidatedMessage,
	parseServerWsMessage,
	PreamblesInvalidatedMessage,
} from '$shared/ws-events';

export class PreamblesRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsMessageLog,
		private readonly preambles: Pick<PreamblesStore, 'refreshIfLoaded'>,
		private readonly selectionInvalidations?: Pick<ChatPreambleSelectionInvalidationHub, 'publish'>,
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			if (message.data.type !== 'preambles-invalidated' && message.data.type !== 'chat-preambles-invalidated') continue;
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof PreamblesInvalidatedMessage) {
				void this.preambles.refreshIfLoaded();
			} else if (parsed instanceof ChatPreamblesInvalidatedMessage) {
				this.selectionInvalidations?.publish({
					kind: 'selection',
					chatId: parsed.chatId,
					revision: parsed.revision,
				});
			}
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
