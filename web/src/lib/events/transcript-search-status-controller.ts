import type { TranscriptSearchStatusV1 } from '$shared/chat-search';
import { getTranscriptSearchStatus } from '$lib/api/chats';
import { parseServerWsMessage, TranscriptSearchStatusMessage } from '$shared/ws-events';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';

export class TranscriptSearchStatusController {
	readonly #ws: WsMessageLog;
	readonly #onStatus: (status: TranscriptSearchStatusV1) => void;
	#handle: DrainHandle | null = null;
	#refreshAbort: AbortController | null = null;

	constructor(
		ws: WsMessageLog,
		onStatus: (status: TranscriptSearchStatusV1) => void,
		private readonly getStatus = getTranscriptSearchStatus,
	) {
		this.#ws = ws;
		this.#onStatus = onStatus;
	}

	start(): void {
		if (this.#handle) return;
		this.#handle = createDrainCursor(this.#ws);
	}

	tick(): void {
		if (!this.#handle) return;
		let latest: TranscriptSearchStatusMessage | null = null;
		for (const message of this.#handle.drain()) {
			if (message.data.type !== 'transcript-search-status') continue;
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof TranscriptSearchStatusMessage) latest = parsed;
		}
		if (latest) {
			this.cancelRefresh();
			this.#onStatus(latest.status);
		}
	}

	async refresh(): Promise<void> {
		this.cancelRefresh();
		if (!this.#handle) return;
		const abortController = new AbortController();
		this.#refreshAbort = abortController;
		try {
			const status = await this.getStatus({ signal: abortController.signal });
			if (!abortController.signal.aborted) this.#onStatus(status);
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
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
