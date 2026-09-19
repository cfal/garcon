import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';
import { ExecutionNodesChangedMessage, parseServerWsMessage } from '$shared/ws-events';

export class ExecutionNodesRouter {
	#handle: DrainHandle | null = null;
	constructor(private readonly ws: WsConnection, private readonly nodes: Pick<ExecutionNodesStore, 'applySnapshot'>) {}
	start(): void { this.#handle ??= createDrainCursor(this.ws); }
	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof ExecutionNodesChangedMessage) this.nodes.applySnapshot(parsed.nodes);
		}
	}
	destroy(): void { this.#handle?.cleanup(); this.#handle = null; }
}
