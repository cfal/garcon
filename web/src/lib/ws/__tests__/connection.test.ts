import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GARCON_WS_AUTH_PROTOCOL_PREFIX, GARCON_WS_PROTOCOL } from '$shared/ws-auth';
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
	readonly protocols: string | string[] | undefined;
	readyState = MockWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = MockWebSocket.CLOSED;
	});

	constructor(url: string, protocols?: string | string[]) {
		this.url = url;
		this.protocols = protocols;
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
		expect(second.url).not.toContain('second-token');
		expect(new URL(second.url).searchParams.has('token')).toBe(false);
		expect(second.protocols).toEqual([
			GARCON_WS_PROTOCOL,
			`${GARCON_WS_AUTH_PROTOCOL_PREFIX}second-token`,
		]);

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

	it('publishes connection status transitions', () => {
		vi.setSystemTime(1_000);
		const connection = new WsConnection();

		expect(connection.connectionStatus.phase).toBe('idle');

		connection.connect('token');

		expect(connection.connectionStatus).toMatchObject({
			phase: 'connecting',
			reason: 'initial-connect',
			episodeId: 0,
			reconnectAttempt: 0,
			nextRetryAt: null,
		});

		const socket = mockSockets[0];
		socket.open();

		expect(connection.connectionStatus).toMatchObject({
			phase: 'connected',
			reason: null,
			reconnectAttempt: 0,
			nextRetryAt: null,
			lastConnectedAt: 1_000,
		});

		vi.setSystemTime(2_000);
		socket.closeFromServer();

		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reason: 'socket-close',
			episodeId: 1,
			reconnectAttempt: 1,
			lastDisconnectedAt: 2_000,
			nextRetryAt: 2_250,
		});

		connection.disconnect();
		expect(connection.connectionStatus.phase).toBe('destroyed');
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
		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reason: 'heartbeat-timeout',
		});
		expect(mockSockets).toHaveLength(2);
		expect(mockSockets[1].url).not.toContain('stored-token');
		expect(mockSockets[1].protocols).toEqual([
			GARCON_WS_PROTOCOL,
			`${GARCON_WS_AUTH_PROTOCOL_PREFIX}stored-token`,
		]);

		connection.disconnect();
	});

	it('retries an established socket quickly, then backs off repeated failures', async () => {
		vi.setSystemTime(1_000);
		const connection = new WsConnection();

		connection.connect('token');
		const first = mockSockets[0];
		first.open();

		await vi.advanceTimersByTimeAsync(15_000);
		expect(lastSentPayload(first)).toMatchObject({ type: 'ws-ping' });

		first.closeFromServer();
		await flushPromises();

		expect(connection.isConnected).toBe(false);
		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reason: 'socket-close',
			reconnectAttempt: 1,
			nextRetryAt: 16_250,
		});
		expect(mockSockets).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(249);
		expect(mockSockets).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(mockSockets).toHaveLength(2);

		mockSockets[1].closeFromServer();
		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reason: 'socket-close',
			reconnectAttempt: 2,
			nextRetryAt: 17_050,
		});

		await vi.advanceTimersByTimeAsync(799);
		expect(mockSockets).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1);
		expect(mockSockets).toHaveLength(3);

		connection.disconnect();
	});

	it('keeps retry progression when a reconnect opens but closes before becoming stable', async () => {
		const connection = new WsConnection();

		connection.connect('token');
		mockSockets[0].open();
		mockSockets[0].closeFromServer();

		await vi.advanceTimersByTimeAsync(250);
		mockSockets[1].open();
		expect(connection.connectionStatus.reconnectAttempt).toBe(1);

		await vi.advanceTimersByTimeAsync(9_999);
		mockSockets[1].closeFromServer();
		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reconnectAttempt: 2,
		});

		await vi.advanceTimersByTimeAsync(800);
		expect(mockSockets).toHaveLength(3);

		connection.disconnect();
	});

	it('resets retry progression after the replacement socket remains stable', async () => {
		vi.setSystemTime(0);
		const connection = new WsConnection();

		connection.connect('token');
		mockSockets[0].open();
		mockSockets[0].closeFromServer();
		await vi.advanceTimersByTimeAsync(250);

		mockSockets[1].open();
		expect(connection.connectionStatus.reconnectAttempt).toBe(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(connection.connectionStatus.reconnectAttempt).toBe(0);

		mockSockets[1].closeFromServer();
		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reconnectAttempt: 1,
			nextRetryAt: 10_500,
		});

		connection.disconnect();
	});

	it('does not overwrite destroyed status when disconnect rejects an in-flight heartbeat', async () => {
		const connection = new WsConnection();

		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		await vi.advanceTimersByTimeAsync(15_000);
		expect(lastSentPayload(socket)).toMatchObject({ type: 'ws-ping' });

		connection.disconnect();
		await flushPromises();

		expect(connection.connectionStatus).toMatchObject({
			phase: 'destroyed',
			reason: 'manual-disconnect',
		});
		expect(mockSockets).toHaveLength(1);
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
		expect(connection.connectionStatus).toMatchObject({
			phase: 'offline',
			reason: 'browser-offline',
		});
		expect(mockSockets).toHaveLength(1);

		window.dispatchEvent(new Event('online'));

		expect(mockSockets).toHaveLength(2);
		expect(mockSockets[1].url).not.toContain('stored-token');
		expect(mockSockets[1].protocols).toEqual([
			GARCON_WS_PROTOCOL,
			`${GARCON_WS_AUTH_PROTOCOL_PREFIX}stored-token`,
		]);
		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reason: 'browser-online',
		});

		connection.disconnect();
	});
});
