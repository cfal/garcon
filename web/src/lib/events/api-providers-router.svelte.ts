import type { ApiProvidersStore } from '$lib/api-providers/api-providers-store.svelte.js';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';
import { ApiProvidersInvalidatedMessage, parseServerWsMessage } from '$shared/ws-events';

export class ApiProvidersRouter {
	#handle: DrainHandle | null = null;
	constructor(
		private readonly ws: WsConnection,
		private readonly providers: Pick<ApiProvidersStore, 'invalidate'>,
	) {}
	start(): void {
		this.#handle ??= createDrainCursor(this.ws);
	}
	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			if (parseServerWsMessage(message.data) instanceof ApiProvidersInvalidatedMessage)
				this.providers.invalidate();
		}
	}
	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
