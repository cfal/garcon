import type { ScheduledTasksStore } from '$lib/stores/scheduled-tasks.svelte.js';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';
import { parseServerWsMessage, ScheduledTasksInvalidatedMessage } from '$shared/ws-events';

export class ScheduledTasksRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsConnection,
		private readonly tasks: ScheduledTasksStore,
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof ScheduledTasksInvalidatedMessage) {
				void this.tasks.refreshIfLoaded();
			}
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
