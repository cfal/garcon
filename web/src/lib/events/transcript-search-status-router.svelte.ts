import type { TranscriptSearchStatusV1 } from '$shared/chat-search';
import { parseServerWsMessage, TranscriptSearchStatusMessage } from '$shared/ws-events';
import type { WsConnection } from '$lib/ws/connection.svelte';
import { createDrainCursor, type DrainHandle } from '$lib/ws/drain';

export class TranscriptSearchStatusRouter {
	readonly #ws: WsConnection;
	readonly #onStatus: (status: TranscriptSearchStatusV1) => void;
	#handle: DrainHandle | null = null;

	constructor(ws: WsConnection, onStatus: (status: TranscriptSearchStatusV1) => void) {
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
