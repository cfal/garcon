import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachShellSocket, sendShellMessage } from '../shell-transport';
import type { ShellTransportHandlers } from '../shell-transport';

// Minimal WebSocket stub with the subset of API shell-transport uses.
function createMockSocket(): WebSocket {
	const socket = {
		readyState: WebSocket.OPEN,
		onopen: null as ((ev: Event) => void) | null,
		onclose: null as ((ev: Event) => void) | null,
		onerror: null as ((ev: Event) => void) | null,
		onmessage: null as ((ev: MessageEvent) => void) | null,
		send: vi.fn(),
	};
	return socket as unknown as WebSocket;
}

function createHandlers(): ShellTransportHandlers {
	return {
		onMessage: vi.fn(),
		onOpen: vi.fn(),
		onClose: vi.fn(),
		onError: vi.fn(),
	};
}

describe('attachShellSocket', () => {
	let socket: WebSocket;
	let handlers: ShellTransportHandlers;

	beforeEach(() => {
		socket = createMockSocket();
		handlers = createHandlers();
		attachShellSocket(socket, handlers);
	});

	it('wires onopen handler', () => {
		socket.onopen!({} as Event);
		expect(handlers.onOpen).toHaveBeenCalledOnce();
	});

	it('wires onclose handler', () => {
		socket.onclose!({} as CloseEvent);
		expect(handlers.onClose).toHaveBeenCalledOnce();
	});

	it('wires onerror handler', () => {
		socket.onerror!({} as Event);
		expect(handlers.onError).toHaveBeenCalledOnce();
	});

	it('dispatches a parsed output message', () => {
		const event = { data: JSON.stringify({ type: 'output', data: 'hello' }) } as MessageEvent;
		socket.onmessage!(event);
		expect(handlers.onMessage).toHaveBeenCalledWith({ type: 'output', data: 'hello' });
	});

	it('dispatches a parsed exit message', () => {
		const event = { data: JSON.stringify({ type: 'exit', exitCode: 0 }) } as MessageEvent;
		socket.onmessage!(event);
		expect(handlers.onMessage).toHaveBeenCalledWith({ type: 'exit', exitCode: 0, signal: undefined });
	});

	it('silently drops unparseable JSON', () => {
		const event = { data: 'not json' } as MessageEvent;
		socket.onmessage!(event);
		expect(handlers.onMessage).not.toHaveBeenCalled();
		expect(handlers.onError).not.toHaveBeenCalled();
	});

	it('silently drops messages with unknown type', () => {
		const event = { data: JSON.stringify({ type: 'unknown_type' }) } as MessageEvent;
		socket.onmessage!(event);
		expect(handlers.onMessage).not.toHaveBeenCalled();
	});

	it('does not call onError for valid JSON with unknown type', () => {
		const event = { data: JSON.stringify({ type: 'unknown_type' }) } as MessageEvent;
		socket.onmessage!(event);
		expect(handlers.onError).not.toHaveBeenCalled();
	});
});

describe('sendShellMessage', () => {
	it('sends JSON to an open socket and returns true', () => {
		const socket = createMockSocket();
		const result = sendShellMessage(socket, { type: 'input', data: 'ls\n' });
		expect(result).toBe(true);
		expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'ls\n' }));
	});

	it('returns false when socket is null', () => {
		const result = sendShellMessage(null, { type: 'input', data: 'x' });
		expect(result).toBe(false);
	});

	it('returns false when socket is not OPEN', () => {
		const socket = createMockSocket();
		(socket as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
		const result = sendShellMessage(socket, { type: 'input', data: 'x' });
		expect(result).toBe(false);
		expect(socket.send).not.toHaveBeenCalled();
	});

	it('sends resize messages', () => {
		const socket = createMockSocket();
		const msg = { type: 'resize' as const, cols: 80, rows: 24 };
		sendShellMessage(socket, msg);
		expect(socket.send).toHaveBeenCalledWith(JSON.stringify(msg));
	});
});
