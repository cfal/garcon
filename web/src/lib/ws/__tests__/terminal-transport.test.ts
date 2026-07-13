import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStreamServerMessage } from '$shared/terminal';
import { TerminalTransport } from '../terminal-transport.svelte';

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly url: string;
	readonly protocols: string | string[] | undefined;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;

	constructor(url: string | URL, protocols?: string | string[]) {
		this.url = String(url);
		this.protocols = protocols;
		FakeWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	send(payload: string): void {
		this.sent.push(payload);
	}

	message(message: TerminalStreamServerMessage): void {
		this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
	}

	serverClose(code: number, reason: string): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.(new CloseEvent('close', { code, reason }));
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
	}
}

describe('TerminalTransport', () => {
	let token: string | null;
	let authDisabled: boolean;
	let messages: TerminalStreamServerMessage[];
	let connected: ReturnType<typeof vi.fn<() => void>>;
	let disconnected: ReturnType<typeof vi.fn<(reason: string) => void>>;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeWebSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeWebSocket);
		token = 'token-1';
		authDisabled = false;
		messages = [];
		connected = vi.fn<() => void>();
		disconnected = vi.fn<(reason: string) => void>();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function createTransport(): TerminalTransport {
		return new TerminalTransport({
			getToken: () => token,
			getAuthDisabled: () => authDisabled,
			onMessage: (message) => messages.push(message),
			onConnected: connected,
			onDisconnected: disconnected,
		});
	}

	it('opens one authenticated stream and routes typed messages', async () => {
		const transport = createTransport();
		transport.connect();
		transport.connect();
		const socket = FakeWebSocket.instances[0];
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(socket.url).toContain('/shell?');
		socket.open();
		expect(transport.status).toBe('reconciling');
		await Promise.resolve();
		socket.message({
			type: 'terminal-output',
			terminalId: 'terminal-1',
			sequence: 1,
			data: 'ok',
		});

		expect(transport.status).toBe('connected');
		expect(connected).toHaveBeenCalledOnce();
		expect(messages).toEqual([{
			type: 'terminal-output',
			terminalId: 'terminal-1',
			sequence: 1,
			data: 'ok',
		}]);
	});

	it('opens without a token when authentication is disabled', () => {
		token = null;
		authDisabled = true;
		const transport = createTransport();
		transport.connect();

		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(transport.status).toBe('connecting');
	});

	it('waits for authentication when a token is missing', () => {
		token = null;
		const transport = createTransport();
		transport.connect();

		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(transport.status).toBe('waiting-auth');
		token = 'token-2';
		transport.authChanged();
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it('reconnects ordinary network loss with a capped retry timer', async () => {
		const transport = createTransport();
		transport.connect();
		FakeWebSocket.instances[0].open();
		await Promise.resolve();
		FakeWebSocket.instances[0].serverClose(1006, 'network');
		expect(transport.status).toBe('reconnecting');

		vi.advanceTimersByTime(499);
		expect(FakeWebSocket.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it('waits after expiry until the credential changes', async () => {
		const transport = createTransport();
		transport.connect();
		FakeWebSocket.instances[0].open();
		await Promise.resolve();
		FakeWebSocket.instances[0].serverClose(4001, 'TERMINAL_AUTH_EXPIRED');
		expect(transport.status).toBe('waiting-auth');
		expect(FakeWebSocket.instances).toHaveLength(1);

		token = 'token-2';
		transport.authChanged();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it('reconnects proactively when an authenticated session rotates its token', async () => {
		const transport = createTransport();
		transport.connect();
		const first = FakeWebSocket.instances[0];
		first.open();
		await Promise.resolve();
		token = 'token-2';
		transport.authChanged();

		expect(first.readyState).toBe(FakeWebSocket.CLOSED);
		expect(disconnected).toHaveBeenCalledWith('client-reconnect');
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it('preserves terminal input messages without request acknowledgements', async () => {
		const transport = createTransport();
		transport.connect();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		expect(transport.send({
			type: 'terminal-input',
			terminalId: 'terminal-1',
			data: 'too-early',
		})).toBe(false);
		await Promise.resolve();

		expect(transport.send({
			type: 'terminal-input',
			terminalId: 'terminal-1',
			data: 'ls\n',
		})).toBe(true);
		expect(JSON.parse(socket.sent[0])).toEqual({
			type: 'terminal-input',
			terminalId: 'terminal-1',
			data: 'ls\n',
		});
	});
});
