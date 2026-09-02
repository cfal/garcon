// Parses generic WebSocket events while excluding frames owned by the terminal transport.
// Drops unknown or malformed payloads with a diagnostic log.

import { parseTerminalStreamServerMessage } from '$shared/terminal';
import type { ServerWsMessage, EventKey } from '$shared/ws-events';
import { parseServerWsMessage } from '$shared/ws-events';

export interface NormalizedEvent {
	key: EventKey;
	message: ServerWsMessage;
}

export function normalizeEvent(raw: Record<string, unknown>): NormalizedEvent | null {
	if (parseTerminalStreamServerMessage(raw)) return null;
	const message = parseServerWsMessage(raw);
	if (!message) {
		console.error('[ws-events] Unknown message type, dropping:', raw.type, raw);
		return null;
	}

	return { key: message.type, message };
}
