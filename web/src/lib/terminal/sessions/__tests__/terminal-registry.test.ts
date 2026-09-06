import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import type { TerminalMetadata, TerminalStreamClientMessage } from '$shared/terminal';
import type {
	TerminalRuntime,
	TerminalRuntimeOptions,
} from '$lib/terminal/runtime/terminal-runtime.svelte.js';
import type {
	TerminalTransportOptions,
	TerminalTransportStatus,
} from '$lib/ws/terminal-transport.svelte';
import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte';
import {
	TERMINAL_CREATE_RETRY_WINDOW_MS,
	TerminalRegistry,
	type TerminalRegistryDeps,
	type TerminalRuntimeModule,
	type TerminalTransportPort,
} from '$lib/terminal/sessions/terminal-registry.svelte.js';
import { ModuleImportError } from '$lib/utils/module-import-error.js';
import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
import { shouldWaitForTerminalRenderer } from '$lib/components/terminal/terminal-renderer-frame.js';

function metadata(
	terminalId: string,
	displaySequence: number,
	overrides: Partial<TerminalMetadata> = {},
): TerminalMetadata {
	return {
		terminalId,
		displaySequence,
		title: null,
		initialWorkingDirectory: `/workspace/${displaySequence}`,
		processStatus: 'running',
		attachmentStatus: 'detached',
		createdAt: '2026-07-13T00:00:00.000Z',
		exitCode: null,
		latestOutputSequence: 0,
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

class FakeTransport implements TerminalTransportPort {
	status: TerminalTransportStatus = 'idle';
	error: string | null = null;
	sent: TerminalStreamClientMessage[] = [];
	connectCount = 0;
	suspendCount = 0;
	destroyCount = 0;

	constructor(readonly options: TerminalTransportOptions) {}

	connect(): void {
		this.connectCount += 1;
		this.status = 'connecting';
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

	suspend(): void {
		this.suspendCount += 1;
		this.status = 'idle';
	}
	destroy(): void {
		this.destroyCount += 1;
		this.status = 'closed';
	}
}

class FakeRuntime {
	writes: string[] = [];
	resendSize = vi.fn();
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
	let renameTerminal: ReturnType<typeof vi.fn>;
	let onSessionTerminated: ReturnType<typeof vi.fn>;
	let onSuccessfulList: ReturnType<typeof vi.fn<(terminalIds: readonly string[]) => void>>;
	let now: number;

	beforeEach(() => {
		vi.useFakeTimers();
		now = 1_000;
		listTerminals = vi
			.fn<() => Promise<{ success: true; terminals: TerminalMetadata[] }>>()
			.mockResolvedValue({ success: true, terminals: [] });
		createTerminal = vi.fn();
		renameTerminal = vi.fn();
		onSessionTerminated = vi.fn();
		onSuccessfulList = vi.fn<(terminalIds: readonly string[]) => void>();
		terminateTerminal = vi.fn().mockResolvedValue({
			success: true,
			terminalId: 'terminal-1',
			terminal: null,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createRegistry(
		overrides: {
			createRuntime?: NonNullable<TerminalRegistryDeps['createRuntime']> | null;
			loadRuntime?: NonNullable<TerminalRegistryDeps['loadRuntime']>;
			reloadApplication?: () => void;
		} = {},
	): TerminalRegistry {
		const connection = {
			isConnected: false,
			sendMessage: () => false,
			addMessageConsumer: () => () => undefined,
			onConnectionChange: () => () => undefined,
		} satisfies PrimaryWsConnectionPort;
		const deps: TerminalRegistryDeps = {
			connection,
			getClientId: () => 'client-1',
			now: () => now,
			listTerminals,
			createTerminal: createTerminal as NonNullable<TerminalRegistryDeps['createTerminal']>,
			terminateTerminal: terminateTerminal as NonNullable<
				TerminalRegistryDeps['terminateTerminal']
			>,
			renameTerminal: renameTerminal as NonNullable<TerminalRegistryDeps['renameTerminal']>,
			createTransport: (options) => {
				transport = new FakeTransport(options);
				return transport;
			},
			onSessionTerminated: onSessionTerminated as NonNullable<
				TerminalRegistryDeps['onSessionTerminated']
			>,
			onSuccessfulList,
			reloadApplication: overrides.reloadApplication,
		};
		if (overrides.createRuntime !== null) {
			deps.createRuntime =
				overrides.createRuntime ??
				((options) => {
					const runtime = new FakeRuntime(options);
					return runtime as unknown as TerminalRuntime;
				});
		}
		if (overrides.loadRuntime) deps.loadRuntime = overrides.loadRuntime;
		return new TerminalRegistry(deps);
	}

	it('notifies layout reconciliation once per successful authoritative List', async () => {
		listTerminals.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
			success: true,
			terminals: [metadata('terminal-2', 2), metadata('terminal-1', 1)],
		});
		const registry = createRegistry();

		await expect(registry.list()).rejects.toThrow('offline');
		expect(onSuccessfulList).not.toHaveBeenCalled();
		await registry.list();

		expect(onSuccessfulList).toHaveBeenCalledOnce();
		expect(onSuccessfulList).toHaveBeenCalledWith(['terminal-1', 'terminal-2']);

		transport.options.onMessage({
			type: 'terminal-status',
			terminal: metadata('terminal-1', 1, { processStatus: 'exited' }),
		});
		expect(onSuccessfulList).toHaveBeenCalledOnce();
	});

	it('keeps runtime lookup pure until creation is explicitly requested', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const registry = createRegistry();
		await registry.list();

		expect(registry.runtimeIfPresent('terminal-1')).toBeNull();
		const firstRequest = registry.ensureRuntime('terminal-1');
		const secondRequest = registry.ensureRuntime('terminal-1');
		expect(firstRequest).toBe(secondRequest);
		expect(registry.sessions['terminal-1'].runtimeState).toBe('loading');
		const runtime = await firstRequest;

		expect(registry.runtimeIfPresent('terminal-1')).toBe(runtime);
		expect(registry.sessions['terminal-1'].runtimeState).toBe('ready');
		expect(await registry.ensureRuntime('terminal-1')).toBe(runtime);
	});

	it('retries a rejected runtime module load', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const loadRuntime = vi
			.fn<() => Promise<TerminalRuntimeModule>>()
			.mockRejectedValueOnce(new Error('Terminal chunk unavailable'))
			.mockResolvedValue({
				createTerminalRuntime: async (options) =>
					new FakeRuntime(options) as unknown as TerminalRuntime,
			});
		const registry = createRegistry({ createRuntime: null, loadRuntime });
		await registry.list();

		await expect(registry.ensureRuntime('terminal-1')).rejects.toThrow(
			'Terminal chunk unavailable',
		);
		const runtime = await registry.ensureRuntime('terminal-1');

		expect(runtime).toBeInstanceOf(FakeRuntime);
		expect(loadRuntime).toHaveBeenCalledTimes(2);
		expect(registry.sessions['terminal-1'].runtimeState).toBe('ready');
	});

	it('reloads the page when a browser-cached terminal module import fails', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const reloadApplication = vi.fn();
		const loadRuntime = vi
			.fn<() => Promise<TerminalRuntimeModule>>()
			.mockRejectedValue(new ModuleImportError(new Error('Terminal chunk unavailable')));
		const registry = createRegistry({ createRuntime: null, loadRuntime, reloadApplication });
		await registry.list();
		transport.status = 'connected';

		await registry.attach('terminal-1', 'restore');
		expect(registry.sessions['terminal-1']).toMatchObject({
			attachmentState: 'unavailable',
			runtimeState: 'failed',
			runtimeError: 'Terminal chunk unavailable',
			runtimeErrorRequiresPageReload: true,
		});

		registry.reattach('terminal-1');

		expect(reloadApplication).toHaveBeenCalledOnce();
		expect(loadRuntime).toHaveBeenCalledOnce();
		expect(transport.sent).toEqual([]);
	});

	it('loads one runtime before sending the latest attachment request', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const runtimeCreation = deferred<TerminalRuntime>();
		let runtimeOptions: TerminalRuntimeOptions | null = null;
		const createRuntime = vi.fn((options: TerminalRuntimeOptions) => {
			runtimeOptions = options;
			return runtimeCreation.promise;
		});
		const registry = createRegistry({ createRuntime });
		await registry.list();
		transport.status = 'connected';

		const restore = registry.attach('terminal-1', 'restore');
		const takeover = registry.attach('terminal-1', 'takeover');
		const surfaceRuntime = registry.ensureRuntime('terminal-1');
		expect(transport.sent).toEqual([]);
		expect(createRuntime).toHaveBeenCalledOnce();
		expect(registry.sessions['terminal-1'].runtimeState).toBe('loading');
		transport.options.onMessage({
			type: 'terminal-status',
			terminal: metadata('terminal-1', 1, { latestOutputSequence: 4 }),
		});
		transport.options.onMessage({
			type: 'terminal-replay-truncated',
			terminalId: 'terminal-1',
			firstSequence: 5,
		});
		if (!runtimeOptions) throw new Error('Expected terminal runtime options');
		const runtime = new FakeRuntime(runtimeOptions) as unknown as TerminalRuntime;
		runtimeCreation.resolve(runtime);

		await Promise.all([restore, takeover]);
		expect(await surfaceRuntime).toBe(runtime);
		expect(registry.sessions['terminal-1'].runtimeState).toBe('ready');
		expect(transport.sent).toEqual([
			{
					type: 'terminal-attach',
					terminalId: 'terminal-1',
					clientId: 'client-1',
					afterSequence: 4,
					intent: 'takeover',
			},
		]);
	});

	it('waits for concurrent List reconciliation before attaching a loaded runtime', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata('terminal-1', 1)],
			})
			.mockImplementationOnce(() => pendingList.promise);
		const runtimeCreation = deferred<void>();
		const registry = createRegistry({
			createRuntime: async (options) => {
				await runtimeCreation.promise;
				return new FakeRuntime(options) as unknown as TerminalRuntime;
			},
		});
		await registry.list();
		transport.status = 'connected';

		const attachment = registry.attach('terminal-1', 'restore');
		const reconciliation = registry.list();
		runtimeCreation.resolve();
		await Promise.resolve();

		expect(transport.sent).toEqual([]);
		pendingList.resolve({ success: true, terminals: [metadata('terminal-1', 1)] });
		await Promise.all([attachment, reconciliation]);

		expect(registry.sessions['terminal-1']).toMatchObject({
			attachmentState: 'connecting',
			runtimeState: 'ready',
		});
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

	it('leaves attachment retryable when concurrent List reconciliation fails', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata('terminal-1', 1)],
			})
			.mockImplementationOnce(() => pendingList.promise);
		const runtimeCreation = deferred<void>();
		const registry = createRegistry({
			createRuntime: async (options) => {
				await runtimeCreation.promise;
				return new FakeRuntime(options) as unknown as TerminalRuntime;
			},
		});
		await registry.list();
		transport.status = 'connected';

		const attachment = registry.attach('terminal-1', 'restore');
		const reconciliation = registry.list();
		const reconciliationFailure = expect(reconciliation).rejects.toThrow('List failed');
		runtimeCreation.resolve();
		pendingList.reject(new Error('List failed'));

		await reconciliationFailure;
		await attachment;

		expect(registry.sessions['terminal-1']).toMatchObject({
			attachmentState: 'detached',
			runtimeState: 'ready',
		});
		expect(transport.sent).toEqual([]);
	});

	it('keeps failed runtime presentation active and retries attachment', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		let attempt = 0;
		const createRuntime = vi.fn((options: TerminalRuntimeOptions) => {
			attempt += 1;
			if (attempt === 1) return Promise.reject(new Error('Terminal chunk unavailable'));
			return new FakeRuntime(options) as unknown as TerminalRuntime;
		});
		const registry = createRegistry({ createRuntime });
		await registry.list();
		transport.status = 'connected';

		await registry.attach('terminal-1', 'restore');
		expect(transport.sent).toEqual([]);
		expect(registry.sessions['terminal-1']).toMatchObject({
			attachmentState: 'unavailable',
			runtimeState: 'failed',
			runtimeError: 'Terminal chunk unavailable',
			runtimeErrorRequiresPageReload: false,
		});
		const bridge = new SurfaceFrameBridge();
		await expect(
			bridge.activate(shouldWaitForTerminalRenderer(registry.sessions['terminal-1'])),
		).resolves.toBeUndefined();

		await registry.attach('terminal-1', 'takeover');
		expect(createRuntime).toHaveBeenCalledTimes(2);
		expect(registry.sessions['terminal-1'].runtimeState).toBe('ready');
		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]).toMatchObject({ type: 'terminal-attach', intent: 'takeover' });
		const attachRenderer = vi.fn();
		bridge.provideRenderer({ attach: attachRenderer, detach: vi.fn(), focusPrimary: vi.fn() });
		await Promise.resolve();
		await Promise.resolve();
		expect(attachRenderer).toHaveBeenCalledOnce();
	});

	it('disposes a runtime that finishes loading after session removal', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const runtimeCreation = deferred<TerminalRuntime>();
		let runtimeOptions: TerminalRuntimeOptions | null = null;
		const registry = createRegistry({
			createRuntime: (options) => {
				runtimeOptions = options;
				return runtimeCreation.promise;
			},
		});
		await registry.list();
		transport.status = 'connected';
		const attachment = registry.attach('terminal-1', 'restore');
		if (!runtimeOptions) throw new Error('Expected terminal runtime options');
		const runtime = new FakeRuntime(runtimeOptions);

		registry.disposeTerminatedSession('terminal-1');
		runtimeCreation.resolve(runtime as unknown as TerminalRuntime);
		await attachment;

		expect(runtime.disposeCount).toBe(1);
		expect(registry.runtimeIfPresent('terminal-1')).toBeNull();
		expect(transport.sent).toEqual([]);
	});

	it('does not publish a superseded runtime after the terminal ID is reused', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const firstCreation = deferred<TerminalRuntime>();
		const secondCreation = deferred<TerminalRuntime>();
		const runtimeOptions: TerminalRuntimeOptions[] = [];
		const createRuntime = vi.fn((options: TerminalRuntimeOptions) => {
			runtimeOptions.push(options);
			return runtimeOptions.length === 1 ? firstCreation.promise : secondCreation.promise;
		});
		const registry = createRegistry({ createRuntime });
		await registry.list();

		const firstRequest = registry.ensureRuntime('terminal-1');
		registry.disposeTerminatedSession('terminal-1');
		transport.options.onMessage({
			type: 'terminal-status',
			terminal: metadata('terminal-1', 2),
		});
		const secondRequest = registry.ensureRuntime('terminal-1');
		const firstRuntime = new FakeRuntime(runtimeOptions[0]);
		const secondRuntime = new FakeRuntime(runtimeOptions[1]);
		firstCreation.resolve(firstRuntime as unknown as TerminalRuntime);
		secondCreation.resolve(secondRuntime as unknown as TerminalRuntime);

		await expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' });
		await expect(secondRequest).resolves.toBe(secondRuntime);
		expect(firstRuntime.disposeCount).toBe(1);
		expect(registry.runtimeIfPresent('terminal-1')).toBe(secondRuntime);
	});

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
		await vi.waitFor(() =>
			expect(transport.sent).toEqual([
				{
						type: 'terminal-attach',
						terminalId: 'terminal-1',
						clientId: 'client-1',
						afterSequence: 0,
						intent: 'restore',
				},
			]),
		);
	});

	it('does not open a terminal stream when no terminal sessions exist', async () => {
		const registry = createRegistry();

		await registry.initialize();

		expect(listTerminals).toHaveBeenCalledOnce();
		expect(transport.connectCount).toBe(0);
		expect(transport.status).toBe('idle');
	});

	it('suspends on logout and reconnects existing sessions after login', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const registry = createRegistry();
		await registry.initialize();
		expect(transport.connectCount).toBe(1);

		registry.authChanged(false);
		expect(transport.suspendCount).toBe(1);
		expect(transport.status).toBe('idle');

		registry.authChanged(true);
		expect(transport.connectCount).toBe(2);
		expect(transport.status).toBe('connecting');
	});

	it('reconnects waiting-auth transport after authentication refreshes', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const registry = createRegistry();
		await registry.initialize();
		transport.status = 'waiting-auth';

		registry.authChanged(true);

		expect(transport.connectCount).toBe(2);
		expect(transport.status).toBe('connecting');
	});

	it('preserves stream upserts that arrive after a List snapshot starts', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata('terminal-1', 1)],
			})
			.mockImplementationOnce(() => pendingList.promise);
		const registry = createRegistry();
		await registry.list();

		const reconciliation = registry.list();
		transport.options.onMessage({
			type: 'terminal-status',
			terminal: metadata('terminal-1', 1, {
				processStatus: 'exited',
				exitCode: 7,
			}),
		});
		transport.options.onMessage({
			type: 'terminal-status',
			terminal: metadata('terminal-2', 2),
		});
		pendingList.resolve({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		await reconciliation;

		expect(registry.sessions['terminal-1'].metadata).toMatchObject({
			processStatus: 'exited',
			exitCode: 7,
		});
		expect(registry.sessions['terminal-2']?.metadata.terminalId).toBe('terminal-2');
	});

	it('does not resurrect a locally removed session from an older List snapshot', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata('terminal-1', 1)],
			})
			.mockImplementationOnce(() => pendingList.promise);
		const registry = createRegistry();
		await registry.list();
		const runtime = (await registry.ensureRuntime('terminal-1')) as unknown as FakeRuntime;

		const reconciliation = registry.list();
		registry.disposeTerminatedSession('terminal-1');
		pendingList.resolve({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		await reconciliation;

		expect(registry.sessions['terminal-1']).toBeUndefined();
		expect(runtime.disposeCount).toBe(1);
	});

	it('applies rename responses without regressing other session metadata', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [
				metadata('terminal-1', 1, {
					processStatus: 'exited',
					exitCode: 0,
					latestOutputSequence: 4,
				}),
			],
		});
		renameTerminal.mockResolvedValue({
			success: true,
			terminalId: 'terminal-1',
			title: 'Build logs',
		});
		const registry = createRegistry();
		await registry.list();

		await registry.rename('terminal-1', ' Build logs ');

		expect(renameTerminal).toHaveBeenCalledWith({
			terminalId: 'terminal-1',
			title: ' Build logs ',
		});
		expect(registry.sessions['terminal-1'].metadata).toMatchObject({
			title: 'Build logs',
			processStatus: 'exited',
			exitCode: 0,
			latestOutputSequence: 4,
		});
	});

	it('protects a rename from an older List snapshot', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata('terminal-1', 1)],
			})
			.mockImplementationOnce(() => pendingList.promise);
		renameTerminal.mockResolvedValue({
			success: true,
			terminalId: 'terminal-1',
			title: 'Build logs',
		});
		const registry = createRegistry();
		await registry.list();

		const reconciliation = registry.list();
		await registry.rename('terminal-1', 'Build logs');
		pendingList.resolve({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		await reconciliation;

		expect(registry.sessions['terminal-1'].metadata.title).toBe('Build logs');
	});

	it('leaves the current title unchanged when rename fails', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1, { title: 'Current' })],
		});
		renameTerminal.mockRejectedValue(new Error('Rename failed'));
		const registry = createRegistry();
		await registry.list();

		await expect(registry.rename('terminal-1', 'Next')).rejects.toThrow('Rename failed');

		expect(registry.sessions['terminal-1'].metadata.title).toBe('Current');
	});

	it('applies title updates from terminal status broadcasts', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const registry = createRegistry();
		await registry.list();

		transport.options.onMessage({
			type: 'terminal-status',
			terminal: metadata('terminal-1', 1, { title: 'Remote title' }),
		});

		expect(registry.sessions['terminal-1'].metadata.title).toBe('Remote title');
	});

	it('disposes a remotely terminated session and notifies workspace placement', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1)],
		});
		const registry = createRegistry();
		await registry.list();
		const runtime = (await registry.ensureRuntime('terminal-1')) as unknown as FakeRuntime;

		transport.options.onMessage({ type: 'terminal-terminated', terminalId: 'terminal-1' });

		expect(registry.sessions['terminal-1']).toBeUndefined();
		expect(runtime.disposeCount).toBe(1);
		expect(onSessionTerminated).toHaveBeenCalledWith('terminal-1');
		expect(transport.suspendCount).toBe(1);
		expect(transport.status).toBe('idle');
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

		await vi.waitFor(() =>
			expect(transport.sent).toEqual([
				{
					type: 'terminal-attach',
					terminalId: 'terminal-1',
					clientId: 'client-1',
					afterSequence: 0,
					intent: 'restore',
				},
			]),
		);
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
		listTerminals
			.mockResolvedValueOnce({ success: true, terminals: [] })
			.mockResolvedValue({ success: true, terminals: [terminal] });
		createTerminal.mockResolvedValue({ success: true, terminal });
		const registry = createRegistry();

		await expect(registry.create('/workspace', 'request-1')).resolves.toBe('terminal-1');
		expect(createTerminal).toHaveBeenCalledWith({
			requestId: 'request-1',
			requestedInitialWorkingDirectory: '/workspace',
		});
		expect(registry.pendingCreates).toEqual({});
		expect(transport.sent).toEqual([]);

		await transport.open();
		await vi.waitFor(() =>
			expect(transport.sent[0]).toMatchObject({
				type: 'terminal-attach',
				terminalId: 'terminal-1',
				intent: 'restore',
			}),
		);
	});

	it('opens the terminal stream after creating the first session', async () => {
		const terminal = metadata('terminal-1', 1);
		createTerminal.mockResolvedValue({ success: true, terminal });
		const registry = createRegistry();

		await registry.create('/workspace', 'request-1');

		expect(transport.connectCount).toBe(1);
		expect(transport.status).toBe('connecting');
		expect(registry.sessions['terminal-1'].attachmentState).toBe('detached');
	});

	it('retains indeterminate creates until the retry window forces List', async () => {
		createTerminal.mockRejectedValue(new TypeError('Network failed'));
		const registry = createRegistry();

		await expect(registry.create('/workspace', 'request-1')).rejects.toThrow('Network failed');
		expect(registry.pendingCreates['request-1']?.requiresList).toBe(false);

		now += TERMINAL_CREATE_RETRY_WINDOW_MS;
		await vi.advanceTimersByTimeAsync(TERMINAL_CREATE_RETRY_WINDOW_MS);
		expect(listTerminals).toHaveBeenCalledTimes(2);
		expect(registry.pendingCreates).toEqual({});
	});

	it('checks wall-clock age before reusing a delayed pending create timer', async () => {
		createTerminal.mockRejectedValue(new TypeError('Network failed'));
		const registry = createRegistry();

		await expect(registry.create('/workspace', 'request-1')).rejects.toThrow('Network failed');
		expect(createTerminal).toHaveBeenCalledOnce();
		expect(listTerminals).toHaveBeenCalledOnce();

		now += TERMINAL_CREATE_RETRY_WINDOW_MS;
		await expect(registry.create('/workspace', 'request-1')).rejects.toThrow();

		expect(listTerminals).toHaveBeenCalledTimes(2);
		expect(createTerminal).toHaveBeenCalledOnce();
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
		const runtime = (await registry.ensureRuntime('terminal-1')) as unknown as FakeRuntime;
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

	it('applies encoded replay batches and completes fragmented output atomically', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1, { latestOutputSequence: 2 })],
		});
		const registry = createRegistry();
		await registry.list();
		const runtime = (await registry.ensureRuntime('terminal-1')) as unknown as FakeRuntime;
		transport.options.onMessage({
			type: 'terminal-attached',
			terminal: metadata('terminal-1', 1, { latestOutputSequence: 2 }),
			replay: [],
		});
		transport.options.onMessage({
			type: 'terminal-replay-batch',
			terminalId: 'terminal-1',
			chunks: [{ sequence: 1, dataBase64: 'b25l' }],
		});
		transport.options.onMessage({
			type: 'terminal-output-fragment',
			terminalId: 'terminal-1',
			sequence: 2,
			fragmentIndex: 0,
			fragmentCount: 2,
			dataBase64: 'dHdv',
		});

		expect(runtime.writes).toEqual(['one']);
		expect(registry.sessions['terminal-1'].lastReceivedSequence).toBe(1);

		transport.options.onMessage({
			type: 'terminal-output-fragment',
			terminalId: 'terminal-1',
			sequence: 2,
			fragmentIndex: 1,
			fragmentCount: 2,
			dataBase64: '',
		});
		expect(runtime.writes).toEqual(['one', 'two']);
		expect(registry.sessions['terminal-1'].lastReceivedSequence).toBe(2);
	});

	it('terminates explicitly and disposes only the selected runtime', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata('terminal-1', 1), metadata('terminal-2', 2)],
		});
		const registry = createRegistry();
		await registry.list();
		const first = (await registry.ensureRuntime('terminal-1')) as unknown as FakeRuntime;
		const second = (await registry.ensureRuntime('terminal-2')) as unknown as FakeRuntime;

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
