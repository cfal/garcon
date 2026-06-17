import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsConnection } from '../connection.svelte';

vi.mock('$lib/api/client', () => ({
	getAuthToken: vi.fn(() => 'stored-token'),
}));

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly url: string;
	readyState = MockWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = MockWebSocket.CLOSED;
	});

	constructor(url: string) {
		this.url = url;
		mockSockets.push(this);
	}

	open(): void {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.(new Event('open'));
	}

	message(data: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
	}

	closeFromServer(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.(new CloseEvent('close'));
	}
}

let mockSockets: MockWebSocket[] = [];

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function lastSentPayload(socket: MockWebSocket): Record<string, unknown> {
	const raw = socket.send.mock.calls.at(-1)?.[0];
	if (typeof raw !== 'string') throw new Error('No socket payload was sent');
	return JSON.parse(raw) as Record<string, unknown>;
}

describe('WsConnection', () => {
	let originalWebSocket: typeof WebSocket;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		mockSockets = [];
		originalWebSocket = globalThis.WebSocket;
		vi.stubGlobal('WebSocket', MockWebSocket);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.stubGlobal('WebSocket', originalWebSocket);
	});

	it('closes a connecting socket before opening a replacement', () => {
		const connection = new WsConnection();

		connection.connect('first-token');
		const first = mockSockets[0];
		connection.connect('second-token');
		const second = mockSockets[1];

		expect(first.close).toHaveBeenCalledOnce();
		expect(first.onopen).toBeNull();
		expect(second.url).toContain('token=second-token');

		first.open();
		expect(connection.isConnected).toBe(false);

		second.open();
		expect(connection.isConnected).toBe(true);

		expect(connection.sendMessage({ type: 'ping' })).toBe(true);
		expect(first.send).not.toHaveBeenCalled();
		expect(second.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));

		connection.disconnect();
	});

	it('ignores stale socket handlers captured before reconnect', () => {
		const connection = new WsConnection();

		connection.connect('first-token');
		const first = mockSockets[0];
		const staleOpen = first.onopen;
		const staleMessage = first.onmessage;
		const staleClose = first.onclose;

		connection.connect('second-token');
		const second = mockSockets[1];

		staleOpen?.(new Event('open'));
		staleMessage?.({ data: JSON.stringify({ type: 'stale' }) } as MessageEvent);
		staleClose?.(new CloseEvent('close'));

		expect(connection.isConnected).toBe(false);
		expect(connection.messages).toEqual([]);

		vi.advanceTimersByTime(3000);
		expect(mockSockets).toHaveLength(2);

		second.open();
		expect(connection.isConnected).toBe(true);

		connection.disconnect();
	});

	it('stores messages behind the reactive version counter', () => {
		const connection = new WsConnection();

		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		socket.message({ type: 'chat-list-refresh-requested' });

		expect(connection.messageVersion).toBe(1);
		expect(connection.messages).toHaveLength(1);
		expect(connection.messages[0].data).toEqual({ type: 'chat-list-refresh-requested' });

		connection.disconnect();
	});

	it('sends application heartbeats and accepts matching pongs', async () => {
		const connection = new WsConnection();

		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		await vi.advanceTimersByTimeAsync(15_000);

		const ping = lastSentPayload(socket);
		expect(ping).toMatchObject({ type: 'ws-ping' });
		expect(typeof ping.clientRequestId).toBe('string');
		expect(typeof ping.sentAt).toBe('number');

		socket.message({
			type: 'ws-pong',
			clientRequestId: ping.clientRequestId,
			sentAt: ping.sentAt,
			serverTime: '2026-06-17T00:00:00.000Z',
		});
		await flushPromises();

		expect(connection.isConnected).toBe(true);
		expect(mockSockets).toHaveLength(1);

		connection.disconnect();
	});

	it('forces reconnect when a heartbeat pong is not received', async () => {
		const connection = new WsConnection();

		connection.connect('token');
		const first = mockSockets[0];
		first.open();

		await vi.advanceTimersByTimeAsync(15_000);
		expect(lastSentPayload(first)).toMatchObject({ type: 'ws-ping' });

		await vi.advanceTimersByTimeAsync(6_000);
		await flushPromises();

		expect(first.close).toHaveBeenCalledOnce();
		expect(connection.isConnected).toBe(false);
		expect(mockSockets).toHaveLength(2);
		expect(mockSockets[1].url).toContain('token=stored-token');

		connection.disconnect();
	});

	it('rejects pending requests when the socket closes', async () => {
		const connection = new WsConnection();

		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		const request = connection.sendRequest({ type: 'chats-running-query' });
		socket.closeFromServer();

		await expect(request).rejects.toThrow('WebSocket disconnected');

		connection.disconnect();
	});

	it('abandons offline sockets and reconnects immediately when the browser returns online', () => {
		const connection = new WsConnection();

		connection.connect('token');
		const first = mockSockets[0];
		first.open();

		window.dispatchEvent(new Event('offline'));

		expect(first.close).toHaveBeenCalledOnce();
		expect(connection.isConnected).toBe(false);
		expect(mockSockets).toHaveLength(1);

		window.dispatchEvent(new Event('online'));

		expect(mockSockets).toHaveLength(2);
		expect(mockSockets[1].url).toContain('token=stored-token');

		connection.disconnect();
	});
});
