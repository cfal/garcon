import type { IssuesInvalidationHub } from '$lib/issues/catalog/issues-invalidation-hub.js';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';
import { IssuesInvalidatedMessage, parseServerWsMessage } from '$shared/ws-events';

export class IssuesRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsConnection,
		private readonly invalidations: Pick<IssuesInvalidationHub, 'publish'>,
	) {}

	start(): void {
		this.#handle ??= createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof IssuesInvalidatedMessage) {
				this.invalidations.publish({ kind: 'collection', revision: parsed.revision });
			}
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
