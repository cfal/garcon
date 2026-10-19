import type { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub.js';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import { parseServerWsMessage } from '$shared/ws-events';
import { TicketsInvalidatedMessage } from '$shared/ws-revision-invalidations';

export class TicketsRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsMessageLog,
		private readonly invalidations: Pick<TicketsInvalidationHub, 'publish'>,
	) {}

	start(): void {
		this.#handle ??= createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			if (message.data.type !== 'tickets-invalidated') continue;
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof TicketsInvalidatedMessage) {
				this.invalidations.publish({ kind: 'collection', revision: parsed.revision });
			}
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
