import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GARCON_WS_AUTH_PROTOCOL_PREFIX, GARCON_WS_PROTOCOL } from '$shared/ws-auth';
import type { ChatProcessingEntry, ChatProcessingPhase } from '$shared/chat-types';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte';
import { ChatProcessingReconciler } from '../chat-processing-reconciler.svelte';
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

function processingHarness() {
	const phases = new Map<string, ChatProcessingPhase>();
	const order: string[] = [];
	const sessions = {
		applyProcessingEvent(chatId: string, phase: ChatProcessingPhase | null) {
			const previousPhase = phases.get(chatId) ?? null;
			if (phase === null) phases.delete(chatId);
			else phases.set(chatId, phase);
			order.push(`event:${String(phase)}`);
			return { chatId, previousPhase, phase };
		},
		processingPhase(chatId: string) {
			return phases.get(chatId) ?? null;
		},
		reconcileProcessing(entries: readonly ChatProcessingEntry[]) {
			const snapshot = new Map(entries.map((entry) => [entry.chatId, entry.phase]));
			const chatIds = new Set([...phases.keys(), ...snapshot.keys()]);
			const transitions = [...chatIds]
				.map((chatId) => ({
					chatId,
					previousPhase: phases.get(chatId) ?? null,
					phase: snapshot.get(chatId) ?? null,
				}))
				.filter((transition) => transition.previousPhase !== transition.phase);
			phases.clear();
			for (const [chatId, phase] of snapshot) phases.set(chatId, phase);
			order.push(`snapshot:${String(phases.get('chat-1') ?? null)}`);
			return transitions;
		},
	} satisfies Pick<
		ChatSessionsPort,
		'applyProcessingEvent' | 'processingPhase' | 'reconcileProcessing'
	>;
	return { sessions, order, phase: (chatId: string) => phases.get(chatId) ?? null };
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

	it('routes consumed terminal messages outside the retained event log', () => {
		const connection = new WsConnection();
		const terminalMessages: Record<string, unknown>[] = [];
		const removeConsumer = connection.addMessageConsumer((data) => {
			if (data.type !== 'terminal-output') return false;
			terminalMessages.push(data);
			return true;
		});
		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		socket.message({
			type: 'terminal-output',
			terminalId: 'terminal-1',
			sequence: 1,
			data: 'ok',
		});

		expect(terminalMessages).toHaveLength(1);
		expect(connection.messages).toHaveLength(0);
		expect(connection.messageVersion).toBe(0);

		removeConsumer();
		socket.message({
			type: 'terminal-output',
			terminalId: 'terminal-1',
			sequence: 2,
			data: 'next',
		});
		expect(connection.messages).toHaveLength(1);
		connection.disconnect();
	});

	it('isolates a throwing message consumer and continues normal routing', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const connection = new WsConnection();
		connection.addMessageConsumer(() => {
			throw new Error('consumer failed');
		});
		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		socket.message({ type: 'chat-list-refresh-requested' });

		expect(consoleError).toHaveBeenCalledWith(
			'WebSocket message consumer failed:',
			expect.any(Error),
		);
		expect(connection.messages).toHaveLength(1);
		connection.disconnect();
	});

	it('publishes each current connection transition once', () => {
		const connection = new WsConnection();
		const transitions: boolean[] = [];
		connection.onConnectionChange((connected) => transitions.push(connected));
		connection.connect('token');
		const first = mockSockets[0];
		const staleClose = first.onclose;
		first.open();

		connection.connect('replacement-token');
		staleClose?.(new CloseEvent('close'));
		mockSockets[1].open();

		expect(transitions).toEqual([true, false, true]);
		connection.disconnect();
		expect(transitions).toEqual([true, false, true, false]);
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
		const snapshotSources: Array<string | undefined> = [];
		connection.addMessageConsumer((data, context) => {
			if (data.type === 'ws-pong') {
				snapshotSources.push(context.processingSnapshotSource);
			}
			return false;
		});

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
			serverInstanceId: 'server-instance-test',
			processing: { outcome: 'snapshot', chats: [] },
		});
		await flushPromises();

		expect(connection.isConnected).toBe(true);
		expect(mockSockets).toHaveLength(1);
		expect(snapshotSources).toEqual(['heartbeat']);

		connection.disconnect();
	});

	it('applies synchronous consumers before resolving a processing probe', async () => {
		const connection = new WsConnection();
		const order: string[] = [];
		connection.addMessageConsumer((data, context) => {
			if (data.type === 'ws-pong') {
				order.push(`consumer:${context.processingSnapshotSource}`);
			}
			return false;
		});
		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		const probe = connection.requestProcessingSnapshot().then((result) => {
			order.push('resolved');
			return result;
		});
		const ping = lastSentPayload(socket);
		socket.message({
			type: 'ws-pong',
			clientRequestId: ping.clientRequestId,
			sentAt: ping.sentAt,
			serverTime: '2026-06-17T00:00:00.000Z',
			serverInstanceId: 'server-instance-test',
			processing: {
				outcome: 'snapshot',
				chats: [{ chatId: 'chat-1', phase: 'stopping' }],
			},
		});

		await expect(probe).resolves.toEqual({
			outcome: 'snapshot',
			chats: [{ chatId: 'chat-1', phase: 'stopping' }],
		});
		expect(order).toEqual(['consumer:stop-probe', 'resolved']);
		connection.disconnect();
	});

	it('sends a fresh processing probe while a scheduled heartbeat is pending', async () => {
		const connection = new WsConnection();
		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		await vi.advanceTimersByTimeAsync(16_500);
		const heartbeat = lastSentPayload(socket);
		const probe = connection.requestProcessingSnapshot();
		const fresh = lastSentPayload(socket);

		expect(fresh.clientRequestId).not.toBe(heartbeat.clientRequestId);
		expect(socket.send).toHaveBeenCalledTimes(2);

		socket.message({
			type: 'ws-pong',
			clientRequestId: fresh.clientRequestId,
			sentAt: fresh.sentAt,
			serverTime: '2026-06-17T00:00:00.000Z',
			serverInstanceId: 'server-instance-test',
			processing: { outcome: 'snapshot', chats: [] },
		});
		await expect(probe).resolves.toEqual({ outcome: 'snapshot', chats: [] });
		connection.disconnect();
	});

	it('sends an explicit processing probe while the document is hidden', async () => {
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		const connection = new WsConnection();
		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		const probe = connection.requestProcessingSnapshot();
		const ping = lastSentPayload(socket);
		expect(ping).toMatchObject({ type: 'ws-ping' });

		socket.message({
			type: 'ws-pong',
			clientRequestId: ping.clientRequestId,
			sentAt: ping.sentAt,
			serverTime: '2026-06-17T00:00:00.000Z',
			serverInstanceId: 'server-instance-test',
			processing: { outcome: 'snapshot', chats: [] },
		});
		await expect(probe).resolves.toEqual({ outcome: 'snapshot', chats: [] });
		connection.disconnect();
	});

	it('reduces phase events and correlated snapshots in same-socket receipt order', async () => {
		const connection = new WsConnection();
		const processing = processingHarness();
		const reconciler = new ChatProcessingReconciler(connection, processing.sessions);
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		socket.message({
			type: 'chat-processing-updated',
			chatId: 'chat-1',
			phase: 'running',
		});
		const probe = connection.requestProcessingSnapshot();
		const ping = lastSentPayload(socket);
		socket.message({
			type: 'ws-pong',
			clientRequestId: ping.clientRequestId,
			sentAt: ping.sentAt,
			serverTime: '2026-06-17T00:00:00.000Z',
			serverInstanceId: 'server-instance-test',
			processing: { outcome: 'snapshot', chats: [] },
		});
		await probe;
		socket.message({
			type: 'chat-processing-updated',
			chatId: 'chat-1',
			phase: 'running',
		});

		expect(processing.order).toEqual(['event:running', 'snapshot:null', 'event:running']);
		expect(processing.phase('chat-1')).toBe('running');
		info.mockRestore();
		reconciler.destroy();
		connection.disconnect();
	});

	it('rejects a malformed processing probe response without mutating processing state', async () => {
		const connection = new WsConnection();
		const processing = processingHarness();
		const reconciler = new ChatProcessingReconciler(connection, processing.sessions);
		const protocolError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		const probe = connection.requestProcessingSnapshot();
		const ping = lastSentPayload(socket);
		socket.message({
			type: 'ws-pong',
			clientRequestId: ping.clientRequestId,
			sentAt: ping.sentAt,
			serverTime: '2026-06-17T00:00:00.000Z',
			serverInstanceId: 'server-instance-test',
			processing: {
				outcome: 'snapshot',
				chats: [{ chatId: 'chat-1', phase: 'unknown' }],
			},
		});

		await expect(probe).rejects.toThrow('Malformed processing snapshot response');
		expect(processing.order).toEqual([]);
		expect(protocolError).toHaveBeenCalledWith(
			'[WsConnection] Malformed processing snapshot response',
			{ source: 'stop-probe' },
		);
		protocolError.mockRestore();
		reconciler.destroy();
		connection.disconnect();
	});

	it('rejects a pong without an instance identity before applying processing', async () => {
		const connection = new WsConnection();
		const processing = processingHarness();
		const reconciler = new ChatProcessingReconciler(connection, processing.sessions);
		const protocolError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		const probe = connection.requestProcessingSnapshot();
		const ping = lastSentPayload(socket);
		socket.message({
			type: 'ws-pong',
			clientRequestId: ping.clientRequestId,
			sentAt: ping.sentAt,
			serverTime: '2026-06-17T00:00:00.000Z',
			processing: {
				outcome: 'snapshot',
				chats: [{ chatId: 'chat-1', phase: 'running' }],
			},
		});

		await expect(probe).rejects.toThrow('Malformed processing snapshot response');
		expect(processing.order).toEqual([]);
		protocolError.mockRestore();
		reconciler.destroy();
		connection.disconnect();
	});

	it('pauses heartbeats while hidden and probes immediately when the document becomes visible', async () => {
		let visibilityState: DocumentVisibilityState = 'visible';
		vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
		const connection = new WsConnection();
		const snapshotSources: Array<string | undefined> = [];
		connection.addMessageConsumer((data, context) => {
			if (data.type === 'ws-pong') {
				snapshotSources.push(context.processingSnapshotSource);
			}
			return false;
		});

		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();

		visibilityState = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(20_000);
		expect(socket.send).not.toHaveBeenCalled();

		visibilityState = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		const ping = lastSentPayload(socket);
		expect(ping).toMatchObject({ type: 'ws-ping' });
		socket.message({
			type: 'ws-pong',
			clientRequestId: ping.clientRequestId,
			sentAt: ping.sentAt,
			serverTime: '2026-06-17T00:00:00.000Z',
			serverInstanceId: 'server-instance-test',
			processing: { outcome: 'snapshot', chats: [] },
		});
		await flushPromises();
		expect(snapshotSources).toEqual(['visibility']);

		connection.disconnect();
	});

	it('ignores an in-flight heartbeat timeout after the document is hidden', async () => {
		let visibilityState: DocumentVisibilityState = 'visible';
		vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
		const connection = new WsConnection();

		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(lastSentPayload(socket)).toMatchObject({ type: 'ws-ping' });

		visibilityState = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(6_000);
		await flushPromises();

		expect(connection.isConnected).toBe(true);
		expect(mockSockets).toHaveLength(1);

		visibilityState = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		expect(socket.send).toHaveBeenCalledTimes(2);

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

	it('treats inbound terminal frames as liveness while a pong is delayed', async () => {
		vi.setSystemTime(0);
		const connection = new WsConnection();
		connection.addMessageConsumer((data) => data.type === 'terminal-output');
		connection.connect('token');
		const first = mockSockets[0];
		first.open();

		await vi.advanceTimersByTimeAsync(15_000);
		expect(lastSentPayload(first)).toMatchObject({ type: 'ws-ping' });
		await vi.advanceTimersByTimeAsync(5_000);
		first.message({
			type: 'terminal-output',
			terminalId: 'terminal-1',
			sequence: 1,
			data: 'alive',
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await flushPromises();

		expect(connection.isConnected).toBe(true);
		expect(mockSockets).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(21_000);
		await flushPromises();
		expect(first.close).toHaveBeenCalledOnce();
		expect(mockSockets).toHaveLength(2);
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

		const request = connection.sendRequest({ type: 'reconnect-state-query', queueChatIds: [] });
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

	it('waits for visibility before reconnecting a socket that closes in the background', async () => {
		let visibilityState: DocumentVisibilityState = 'visible';
		vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
		const connection = new WsConnection();

		connection.connect('token');
		const socket = mockSockets[0];
		socket.open();
		visibilityState = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		socket.closeFromServer();

		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reason: 'socket-close',
			nextRetryAt: null,
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mockSockets).toHaveLength(1);

		visibilityState = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		expect(mockSockets).toHaveLength(2);

		connection.disconnect();
	});

	it('defers an online reconnect while hidden and coalesces resume events', () => {
		let visibilityState: DocumentVisibilityState = 'visible';
		vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
		const connection = new WsConnection();
		connection.connect('token');
		mockSockets[0].open();

		visibilityState = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		window.dispatchEvent(new Event('offline'));
		window.dispatchEvent(new Event('online'));
		expect(mockSockets).toHaveLength(1);

		visibilityState = 'visible';
		window.dispatchEvent(new Event('online'));
		document.dispatchEvent(new Event('visibilitychange'));
		expect(mockSockets).toHaveLength(2);
		connection.disconnect();
	});

	it('replaces a connecting socket after the resume dedupe window', async () => {
		vi.setSystemTime(0);
		const connection = new WsConnection();
		connection.connect('token');
		const stale = mockSockets[0];

		await vi.advanceTimersByTimeAsync(2_001);
		document.dispatchEvent(new Event('visibilitychange'));

		expect(stale.close).toHaveBeenCalledOnce();
		expect(mockSockets).toHaveLength(2);
		connection.disconnect();
	});

	it('retries when a connection attempt never settles', async () => {
		vi.setSystemTime(0);
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const connection = new WsConnection();
		connection.connect('token');
		mockSockets[0].open();
		mockSockets[0].closeFromServer();
		await vi.advanceTimersByTimeAsync(250);
		const stalled = mockSockets[1];

		await vi.advanceTimersByTimeAsync(10_000);

		expect(stalled.close).toHaveBeenCalledOnce();
		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reason: 'connect-timeout',
			episodeId: 1,
			reconnectAttempt: 2,
			nextRetryAt: 11_050,
			lastDisconnectedAt: 0,
		});
		expect(mockSockets).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(800);
		expect(mockSockets).toHaveLength(3);
		expect(warning).toHaveBeenCalledWith('WebSocket connection attempt timed out');
		connection.disconnect();
	});

	it('defers a timed-out connection attempt while hidden until the page is visible', async () => {
		let visibilityState: DocumentVisibilityState = 'visible';
		vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const connection = new WsConnection();
		connection.connect('token');
		const stalled = mockSockets[0];

		visibilityState = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(10_000);

		expect(stalled.close).toHaveBeenCalledOnce();
		expect(connection.connectionStatus).toMatchObject({
			phase: 'reconnecting',
			reason: 'connect-timeout',
			nextRetryAt: null,
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mockSockets).toHaveLength(1);

		visibilityState = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		expect(mockSockets).toHaveLength(2);
		connection.disconnect();
	});
});
