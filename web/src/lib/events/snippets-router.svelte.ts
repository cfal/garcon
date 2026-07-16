import type { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';
import { parseServerWsMessage, SnippetsInvalidatedMessage } from '$shared/ws-events';

type SnippetsRefreshStore = Pick<SnippetsStore, 'refreshIfLoaded'>;

export class SnippetsRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsConnection,
		private readonly snippets: SnippetsRefreshStore,
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof SnippetsInvalidatedMessage) {
				void this.snippets.refreshIfLoaded();
			}
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
