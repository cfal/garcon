import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import { ExecutorsChangedMessage, parseServerWsMessage } from '$shared/ws-events';

export class ExecutorsRouter {
	#handle: DrainHandle | null = null;
	constructor(private readonly ws: WsMessageLog, private readonly executors: Pick<ExecutorsStore, 'applySnapshot'>) {}
	start(): void { this.#handle ??= createDrainCursor(this.ws); }
	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			if (message.data.type !== 'executors-changed') continue;
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof ExecutorsChangedMessage) this.executors.applySnapshot(parsed.executors);
		}
	}
	destroy(): void { this.#handle?.cleanup(); this.#handle = null; }
}
