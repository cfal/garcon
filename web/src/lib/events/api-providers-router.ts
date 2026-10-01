import type { ApiProvidersStore } from '$lib/api-providers/api-providers-store.svelte.js';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import { ApiProvidersInvalidatedMessage, parseServerWsMessage } from '$shared/ws-events';

export class ApiProvidersRouter {
	#handle: DrainHandle | null = null;
	constructor(
		private readonly ws: WsMessageLog,
		private readonly providers: Pick<ApiProvidersStore, 'invalidate'>,
	) {}
	start(): void {
		this.#handle ??= createDrainCursor(this.ws);
	}
	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			if (message.data.type !== 'api-providers-invalidated') continue;
			if (parseServerWsMessage(message.data) instanceof ApiProvidersInvalidatedMessage)
				this.providers.invalidate();
		}
	}
	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
