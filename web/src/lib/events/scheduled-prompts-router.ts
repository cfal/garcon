import type { ScheduledPromptsStore } from '$lib/scheduling/scheduled-prompts-store.svelte.js';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import { parseServerWsMessage, ScheduledPromptsInvalidatedMessage } from '$shared/ws-events';

export class ScheduledPromptsRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsMessageLog,
		private readonly prompts: Pick<ScheduledPromptsStore, 'refreshIfLoaded'>,
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			if (message.data.type !== 'scheduled-prompts-invalidated') continue;
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof ScheduledPromptsInvalidatedMessage) {
				void this.prompts.refreshIfLoaded();
			}
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
