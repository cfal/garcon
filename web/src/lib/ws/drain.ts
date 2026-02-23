// Framework-agnostic drain cursor for consuming WebSocket messages.
// Each consumer maintains its own read position into the shared
// message log, enabling multiple independent subscribers to process
// every message exactly once.

import type { WsConnection, DrainCursor, WsMessage } from './connection.svelte';

export interface DrainHandle {
	/** Returns all messages received since the last drain call. */
	drain: () => WsMessage[];
	/** Unregisters the cursor from cooperative trimming. */
	cleanup: () => void;
}

export function createDrainCursor(connection: WsConnection): DrainHandle {
	const cursor: DrainCursor = { current: 0 };
	const cleanup = connection.registerCursor(cursor);

	function drain(): WsMessage[] {
		const log = connection.messages;
		const offset = connection.trimOffset;
		const localIndex = cursor.current - offset;

		if (localIndex >= log.length) return [];

		const start = Math.max(0, localIndex);
		const messages = log.slice(start);
		cursor.current = offset + log.length;
		return messages;
	}

	return { drain, cleanup };
}
