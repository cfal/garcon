import type { TranscriptSearchStatusV1 } from '$shared/chat-search';
import { parseServerWsMessage, TranscriptSearchStatusMessage } from '$shared/ws-events';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';

export class TranscriptSearchStatusRouter {
	readonly #ws: WsMessageLog;
	readonly #onStatus: (status: TranscriptSearchStatusV1) => void;
	#handle: DrainHandle | null = null;

	constructor(ws: WsMessageLog, onStatus: (status: TranscriptSearchStatusV1) => void) {
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
		if (latest) this.#onStatus(latest.status);
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
