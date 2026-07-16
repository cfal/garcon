import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrimaryWsClientMessage } from '$shared/ws-protocol';
import type { TerminalStreamServerMessage } from '$shared/terminal';
import type {
	PrimaryWsConnectionPort,
	WsConnectionListener,
	WsMessageConsumer,
} from '../connection.svelte';
import { TerminalTransport } from '../terminal-transport.svelte';

class FakeConnection implements PrimaryWsConnectionPort {
	isConnected = false;
	readonly sent: PrimaryWsClientMessage[] = [];
	readonly consumers = new Set<WsMessageConsumer>();
	readonly listeners = new Set<WsConnectionListener>();

	sendMessage(message: PrimaryWsClientMessage): boolean {
		if (!this.isConnected) return false;
		this.sent.push(message);
		return true;
	}

	addMessageConsumer(consumer: WsMessageConsumer): () => void {
		this.consumers.add(consumer);
		return () => this.consumers.delete(consumer);
	}

	onConnectionChange(listener: WsConnectionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setConnected(connected: boolean): void {
		if (this.isConnected === connected) return;
		this.isConnected = connected;
		for (const listener of [...this.listeners]) listener(connected);
	}

	receive(message: Record<string, unknown>): boolean {
		for (const consumer of [...this.consumers]) {
			if (consumer(message)) return true;
		}
		return false;
	}
}

describe('TerminalTransport', () => {
	let connection: FakeConnection;
	let messages: TerminalStreamServerMessage[];
	let connected: ReturnType<typeof vi.fn<() => Promise<void> | void>>;
	let ready: ReturnType<typeof vi.fn<() => void>>;
	let disconnected: ReturnType<typeof vi.fn<(reason: string) => void>>;

	beforeEach(() => {
		vi.useFakeTimers();
		connection = new FakeConnection();
		messages = [];
		connected = vi.fn<() => Promise<void> | void>();
		ready = vi.fn<() => void>();
		disconnected = vi.fn<(reason: string) => void>();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function createTransport(): TerminalTransport {
		return new TerminalTransport({
			connection,
			onMessage: (message) => messages.push(message),
			onConnected: connected,
			onReady: ready,
			onDisconnected: disconnected,
		});
	}

	it('registers with the primary connection without constructing a WebSocket', () => {
		const websocket = vi.fn();
		vi.stubGlobal('WebSocket', websocket);

		createTransport();

		expect(websocket).not.toHaveBeenCalled();
		expect(connection.consumers.size).toBe(1);
		expect(connection.listeners.size).toBe(1);
	});

	it('reconciles immediately when the primary connection is already open', async () => {
		connection.setConnected(true);
		const transport = createTransport();

		transport.connect();
		expect(transport.status).toBe('reconciling');
		await Promise.resolve();

		expect(transport.status).toBe('connected');
		expect(connected).toHaveBeenCalledOnce();
		expect(ready).toHaveBeenCalledOnce();
	});

	it('waits for the primary connection before reconciling', async () => {
		const transport = createTransport();
		transport.connect();

		expect(transport.status).toBe('connecting');
		expect(connected).not.toHaveBeenCalled();

		connection.setConnected(true);
		await Promise.resolve();
		expect(transport.status).toBe('connected');
		expect(connected).toHaveBeenCalledOnce();
	});

	it('consumes terminal messages without consuming chat messages', async () => {
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();
		await Promise.resolve();

		expect(
			connection.receive({
				type: 'terminal-output',
				terminalId: 'terminal-1',
				sequence: 1,
				data: 'ok',
			}),
		).toBe(true);
		expect(connection.receive({ type: 'chat-session-created', chatId: 'chat-1' })).toBe(false);
		expect(messages).toEqual([
			{
				type: 'terminal-output',
				terminalId: 'terminal-1',
				sequence: 1,
				data: 'ok',
			},
		]);
	});

	it('invalidates in-flight reconciliation when the primary connection closes', async () => {
		let resolve!: () => void;
		connected.mockReturnValue(new Promise<void>((done) => (resolve = done)));
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();

		connection.setConnected(false);
		resolve();
		await Promise.resolve();

		expect(transport.status).toBe('connecting');
		expect(ready).not.toHaveBeenCalled();
		expect(disconnected).toHaveBeenCalledWith('connection-closed');
	});

	it('reconciles exactly once after the primary connection returns', async () => {
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();
		await Promise.resolve();

		connection.setConnected(false);
		connection.setConnected(true);
		await Promise.resolve();

		expect(connected).toHaveBeenCalledTimes(2);
		expect(ready).toHaveBeenCalledTimes(2);
	});

	it('retries reconciliation locally without replacing the primary socket', async () => {
		connected.mockRejectedValueOnce(new Error('List unavailable')).mockResolvedValueOnce(undefined);
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();
		await Promise.resolve();
		await Promise.resolve();

		expect(transport.status).toBe('reconciling');
		expect(transport.error).toBe('List unavailable');
		expect(disconnected).toHaveBeenCalledWith('reconciliation-failed');

		await vi.advanceTimersByTimeAsync(500);
		expect(connected).toHaveBeenCalledTimes(2);
		expect(transport.status).toBe('connected');
		expect(connection.isConnected).toBe(true);
	});

	it('retries when restoring attachments fails', async () => {
		ready.mockImplementationOnce(() => {
			throw new Error('Restore unavailable');
		});
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();
		await Promise.resolve();
		await Promise.resolve();

		expect(transport.status).toBe('reconciling');
		expect(transport.error).toBe('Restore unavailable');
		expect(disconnected).toHaveBeenCalledWith('reconciliation-failed');

		await vi.advanceTimersByTimeAsync(500);
		expect(connected).toHaveBeenCalledTimes(2);
		expect(ready).toHaveBeenCalledTimes(2);
		expect(transport.status).toBe('connected');
	});

	it('sets connected before restoring attachments', async () => {
		connection.setConnected(true);
		const transport = createTransport();
		ready.mockImplementation(() => {
			expect(transport.status).toBe('connected');
		});

		transport.connect();
		await Promise.resolve();
		expect(ready).toHaveBeenCalledOnce();
	});

	it('suspends reconciliation while still consuming late terminal messages', async () => {
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();
		await Promise.resolve();
		transport.suspend();

		expect(
			connection.receive({
				type: 'terminal-output',
				terminalId: 'terminal-1',
				sequence: 1,
				data: 'late',
			}),
		).toBe(true);
		expect(messages).toEqual([]);
		expect(transport.status).toBe('idle');
	});

	it('does not finish an in-flight reconciliation after suspension', async () => {
		let resolve!: () => void;
		connected.mockReturnValue(new Promise<void>((done) => (resolve = done)));
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();

		transport.suspend();
		resolve();
		await Promise.resolve();

		expect(transport.status).toBe('idle');
		expect(ready).not.toHaveBeenCalled();
	});

	it('waits for a replacement primary connection after terminal auth expires', async () => {
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();
		await Promise.resolve();

		connection.receive({
			type: 'terminal-error',
			code: 'terminal-auth-expired',
			message: 'Terminal authorization expired.',
		});
		expect(transport.status).toBe('waiting-auth');
		expect(disconnected).toHaveBeenCalledWith('terminal-auth-expired');
		expect(
			transport.send({ type: 'terminal-input', terminalId: 'terminal-1', data: 'ignored' }),
		).toBe(false);

		connection.setConnected(false);
		connection.setConnected(true);
		await Promise.resolve();
		expect(transport.status).toBe('connected');
		expect(connected).toHaveBeenCalledTimes(2);
	});

	it('delegates typed terminal messages only after reconciliation', async () => {
		connection.setConnected(true);
		const transport = createTransport();
		transport.connect();
		expect(
			transport.send({ type: 'terminal-input', terminalId: 'terminal-1', data: 'early' }),
		).toBe(false);
		await Promise.resolve();

		expect(
			transport.send({ type: 'terminal-input', terminalId: 'terminal-1', data: 'ls\n' }),
		).toBe(true);
		expect(connection.sent).toEqual([
			{ type: 'terminal-input', terminalId: 'terminal-1', data: 'ls\n' },
		]);
	});

	it('removes primary connection registrations when destroyed', () => {
		const transport = createTransport();

		transport.destroy();

		expect(connection.consumers.size).toBe(0);
		expect(connection.listeners.size).toBe(0);
		expect(transport.status).toBe('closed');
	});
});
