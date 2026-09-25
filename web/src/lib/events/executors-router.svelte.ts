import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';
import { ExecutorsChangedMessage, parseServerWsMessage } from '$shared/ws-events';

export class ExecutorsRouter {
	#handle: DrainHandle | null = null;
	constructor(private readonly ws: WsConnection, private readonly executors: Pick<ExecutorsStore, 'applySnapshot'>) {}
	start(): void { this.#handle ??= createDrainCursor(this.ws); }
	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof ExecutorsChangedMessage) this.executors.applySnapshot(parsed.executors);
		}
	}
	destroy(): void { this.#handle?.cleanup(); this.#handle = null; }
}
