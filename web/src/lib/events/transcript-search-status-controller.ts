import type { TranscriptSearchStatusV1 } from '$shared/chat-search';
import { getTranscriptSearchStatus } from '$lib/api/chats';
import type { WsPushEvents } from '$lib/ws/connection.svelte.js';

export class TranscriptSearchStatusController {
	#unsubscribe: (() => void) | null = null;
	#refreshAbort: AbortController | null = null;

	constructor(
		private readonly ws: WsPushEvents,
		private readonly onStatus: (status: TranscriptSearchStatusV1) => void,
		private readonly getStatus = getTranscriptSearchStatus,
	) {}

	start(): void {
		this.#unsubscribe ??= this.ws.onMessageType('transcript-search-status', ({ status }) => {
			this.cancelRefresh();
			this.onStatus(status);
		});
	}

	async refresh(): Promise<void> {
		this.cancelRefresh();
		if (!this.#unsubscribe) return;
		const abortController = new AbortController();
		this.#refreshAbort = abortController;
		try {
			const status = await this.getStatus({ signal: abortController.signal });
			if (!abortController.signal.aborted) this.onStatus(status);
		} catch {
			// Retains the last known status until a later refresh or WebSocket update.
		} finally {
			if (this.#refreshAbort === abortController) this.#refreshAbort = null;
		}
	}

	cancelRefresh(): void {
		this.#refreshAbort?.abort();
		this.#refreshAbort = null;
	}

	destroy(): void {
		this.cancelRefresh();
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}
}
