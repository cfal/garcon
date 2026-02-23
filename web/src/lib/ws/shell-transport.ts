// Typed shell WebSocket transport helpers. Handles message
// serialization and deserialization at the boundary so callers
// work with typed payloads instead of raw JSON strings.

import { parseShellServerMessage, type ShellServerMessage, type ShellClientMessage } from '$lib/types/shell';

export interface ShellTransportHandlers {
	onMessage: (msg: ShellServerMessage) => void;
	onOpen: () => void;
	onClose: () => void;
	onError: () => void;
}

// Attaches typed event handlers to a shell WebSocket. Parses incoming
// messages through the shell parser and silently drops malformed payloads.
export function attachShellSocket(socket: WebSocket, handlers: ShellTransportHandlers): void {
	socket.onopen = handlers.onOpen;
	socket.onclose = handlers.onClose;
	socket.onerror = handlers.onError;
	socket.onmessage = (event) => {
		try {
			const raw = JSON.parse(event.data as string);
			const msg = parseShellServerMessage(raw);
			if (!msg) return;
			handlers.onMessage(msg);
		} catch {
			// Drops malformed payloads without toggling connection state.
			// Transport errors are surfaced via the socket onerror handler.
			return;
		}
	};
}

// Sends a typed client message over the shell WebSocket.
export function sendShellMessage(socket: WebSocket | null, msg: ShellClientMessage): boolean {
	if (!socket || socket.readyState !== WebSocket.OPEN) return false;
	socket.send(JSON.stringify(msg));
	return true;
}
