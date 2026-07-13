import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import type { TerminalMetadata, TerminalStreamClientMessage } from '$shared/terminal';
import type {
	TerminalRuntime,
	TerminalRuntimeOptions,
} from '$lib/components/terminal/terminal-runtime.svelte';
import type {
	TerminalTransport,
	TerminalTransportOptions,
} from '$lib/ws/terminal-transport.svelte';
import {
	TERMINAL_CREATE_RETRY_WINDOW_MS,
	TerminalRegistry,
	type TerminalRegistryDeps,
} from '../terminal-registry.svelte';

function metadata(
	terminalId: string,
	displaySequence: number,
	overrides: Partial<TerminalMetadata> = {},
): TerminalMetadata {
	return {
		terminalId,
		displaySequence,
		initialWorkingDirectory: `/workspace/${displaySequence}`,
		processStatus: 'running',
		attachmentStatus: 'detached',
		createdAt: '2026-07-13T00:00:00.000Z',
		exitCode: null,
		latestOutputSequence: 0,
		...overrides,
	};
}

class FakeTransport {
	status: TerminalTransport['status'] = 'idle';
	error: string | null = null;
	sent: TerminalStreamClientMessage[] = [];
	connectCount = 0;
	destroyCount = 0;

	constructor(readonly options: TerminalTransportOptions) {}

	connect(): void {
		this.connectCount += 1;
	}

	async open(): Promise<void> {
		this.status = 'reconciling';
		await this.options.onConnected();
		this.status = 'connected';
		this.options.onReady?.();
	}

	send(message: TerminalStreamClientMessage): boolean {
		if (this.status !== 'connected') return false;
		this.sent.push(message);
		return true;
	}

	retryNow(): void {}
	authChanged(): void {}
	destroy(): void {
		this.destroyCount += 1;
		this.status = 'closed';
	}
}

class FakeRuntime {
	writes: string[] = [];
	disposeCount = 0;
	themes: unknown[] = [];

	constructor(readonly options: TerminalRuntimeOptions) {}

	write(data: string): void {
		this.writes.push(data);
	}

	applyTheme(theme: unknown): void {
		this.themes.push(theme);
	}

	dispose(): void {
		this.disposeCount += 1;
	}
}

describe('TerminalRegistry', () => {
	let transport: FakeTransport;
	let listTerminals: ReturnType<
		typeof vi.fn<
			() => Promise<{
				success: true;
				terminals: TerminalMetadata[];
			}>
		>
	>;
	let createTerminal: ReturnType<typeof vi.fn>;
	let terminateTerminal: ReturnType<typeof vi.fn>;
	let now: number;

	beforeEach(() => {
		vi.useFakeTimers();
		now = 1_000;
		listTerminals = vi
			.fn<() => Promise<{ success: true; terminals: TerminalMetadata[] }>>()
			.mockResolvedValue({ success: true, terminals: [] });
		createTerminal = vi.fn();
		terminateTerminal = vi.fn().mockResolvedValue({
			success: true,
			terminalId: 'terminal-1',
			terminal: null,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createRegistry(): TerminalRegistry {
		return new TerminalRegistry({
			getToken: () => 'token',
			getAuthDisabled: () => false,
			getClientId: () => 'client-1',
			now: () => now,
			listTerminals,
			createTerminal: createTerminal as NonNullable<TerminalRegistryDeps['createTerminal']>,
			terminateTerminal: terminateTerminal as NonNullable<
				TerminalRegistryDeps['terminateTerminal']
			>,
			createTransport: (options) => {
				transport = new FakeTransport(options);
				return transport as unknown as TerminalTransport;
			},
			createRuntime: (options) => {
				const runtime = new FakeRuntime(options);
				return runtime as unknown as TerminalRuntime;
			},
		});
	}

	it('lists before opening the stream and lists again before restoring attachments', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const registry = createRegistry();

		await registry.initialize();
		expect(listTerminals).toHaveBeenCalledTimes(1);
		expect(transport.connectCount).toBe(1);
		expect(transport.sent).toEqual([]);

		await transport.open();
		expect(listTerminals).toHaveBeenCalledTimes(2);
		expect(transport.sent).toEqual([
			{
				type: 'terminal-attach',
				terminalId: 'terminal-1',
				clientId: 'client-1',
				afterSequence: 0,
				intent: 'restore',
			},
		]);
	});

	it('lets the server arbitrate restore for a session that was already attached', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1, { attachmentStatus: 'attached' })],
		});
		const registry = createRegistry();
		await registry.list();
		transport.status = 'connected';
		await transport.open();

		expect(transport.sent).toEqual([
			{
				type: 'terminal-attach',
				terminalId: 'terminal-1',
				clientId: 'client-1',
				afterSequence: 0,
				intent: 'restore',
			},
		]);
		transport.options.onMessage({
			type: 'terminal-error',
			code: 'terminal-takeover-required',
			message: 'Terminal is attached in another browser tab.',
			terminalId: 'terminal-1',
		});
		expect(registry.sessions['terminal-1'].attachmentState).toBe('taken-over');
	});

	it('creates with the caller request ID and attaches without creating a second PTY', async () => {
		const terminal = metadata('terminal-1', 1);
		createTerminal.mockResolvedValue({ success: true, terminal });
		const registry = createRegistry();
		transport.status = 'connected';

		await expect(registry.create('/workspace', 'request-1')).resolves.toBe('terminal-1');
		expect(createTerminal).toHaveBeenCalledWith({
			requestId: 'request-1',
			requestedInitialWorkingDirectory: '/workspace',
		});
		expect(registry.pendingCreates).toEqual({});
		expect(transport.sent[0]).toMatchObject({
			type: 'terminal-attach',
			terminalId: 'terminal-1',
			intent: 'restore',
		});
	});

	it('retains indeterminate creates until the retry window forces List', async () => {
		createTerminal.mockRejectedValue(new TypeError('Network failed'));
		const registry = createRegistry();

		await expect(registry.create('/workspace', 'request-1')).rejects.toThrow('Network failed');
		expect(registry.pendingCreates['request-1']?.requiresList).toBe(false);

		now += TERMINAL_CREATE_RETRY_WINDOW_MS;
		await vi.advanceTimersByTimeAsync(TERMINAL_CREATE_RETRY_WINDOW_MS);
		expect(listTerminals).toHaveBeenCalledOnce();
		expect(registry.pendingCreates).toEqual({});
	});

	it('clears a typed server failure immediately', async () => {
		createTerminal.mockRejectedValue(
			new ApiError(500, 'Unable to start terminal.', 'terminal-internal', undefined, true),
		);
		const registry = createRegistry();

		await expect(registry.create('/workspace', 'request-1')).rejects.toThrow(
			'Unable to start terminal.',
		);
		expect(registry.pendingCreates).toEqual({});
	});

	it('deduplicates replay, preserves truncation state, and suppresses taken-over restore', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1, { latestOutputSequence: 3 })],
		});
		const registry = createRegistry();
		await registry.list();
		transport.status = 'connected';
		transport.options.onMessage({
			type: 'terminal-replay-truncated',
			terminalId: 'terminal-1',
			firstSequence: 2,
		});
		transport.options.onMessage({
			type: 'terminal-attached',
			terminal: metadata('terminal-1', 1, { latestOutputSequence: 3 }),
			replay: [
				{ sequence: 1, data: 'old' },
				{ sequence: 2, data: 'two' },
				{ sequence: 3, data: 'three' },
			],
		});
		transport.options.onMessage({
			type: 'terminal-output',
			terminalId: 'terminal-1',
			sequence: 3,
			data: 'duplicate',
		});
		transport.options.onMessage({
			type: 'terminal-taken-over',
			terminalId: 'terminal-1',
			replacementClientId: 'client-2',
		});
		transport.sent = [];
		await transport.open();

		const session = registry.sessions['terminal-1'];
		const runtime = registry.runtime('terminal-1') as unknown as FakeRuntime;
		runtime.options.onInput('blocked');
		runtime.options.onResize({ cols: 100, rows: 30 });
		expect(session.replayTruncatedAt).toBe(2);
		expect(session.lastReceivedSequence).toBe(3);
		expect(session.attachmentState).toBe('taken-over');
		expect(runtime.writes).toEqual(['two', 'three']);
		expect(transport.sent).toEqual([]);

		transport.options.onMessage({
			type: 'terminal-attached',
			terminal: metadata('terminal-1', 1, { latestOutputSequence: 3 }),
			replay: [],
		});
		runtime.options.onInput('allowed');
		runtime.options.onResize({ cols: 120, rows: 40 });
		expect(transport.sent).toEqual([
			{ type: 'terminal-input', terminalId: 'terminal-1', data: 'allowed' },
			{ type: 'terminal-resize', terminalId: 'terminal-1', cols: 120, rows: 40 },
		]);
	});

	it('terminates explicitly and disposes only the selected runtime', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1), metadata('terminal-2', 2)],
		});
		const registry = createRegistry();
		await registry.list();
		const first = registry.runtime('terminal-1') as unknown as FakeRuntime;
		const second = registry.runtime('terminal-2') as unknown as FakeRuntime;

		await registry.requestTermination('terminal-1', 'terminate-1');
		expect(terminateTerminal).toHaveBeenCalledWith({
			terminalId: 'terminal-1',
			requestId: 'terminate-1',
		});
		expect(first.disposeCount).toBe(0);
		expect(registry.sessions['terminal-1']).toBeDefined();

		registry.disposeTerminatedSession('terminal-1');
		expect(first.disposeCount).toBe(1);
		expect(second.disposeCount).toBe(0);
		expect(registry.sessions['terminal-1']).toBeUndefined();
		expect(registry.sessions['terminal-2']).toBeDefined();
	});
});
