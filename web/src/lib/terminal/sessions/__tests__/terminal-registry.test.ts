import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import type {
	TerminalMetadata,
	TerminalStreamClientMessage,
	TerminalStreamServerMessage,
} from '$shared/terminal';
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

const runtimeId = '00000000-0000-4000-8000-000000000001';
const firstId = `local/${runtimeId}/00000000-0000-4000-8000-000000000002`;
const secondId = `local/${runtimeId}/00000000-0000-4000-8000-000000000003`;

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

	emit(message: TerminalStreamServerMessage): void {
		const id =
			'terminal' in message
				? message.terminal.terminalId
				: 'terminalId' in message
					? message.terminalId
					: undefined;
		const attachment = this.sent.findLast(
			(item) => item.type === 'terminal-attach' && item.terminalId === id,
		);
		this.options.onMessage({ ...message, attachmentId: attachment?.attachmentId });
	}

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

	write(data: string): boolean {
		this.writes.push(data);
		return true;
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
			terminalId: firstId,
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
			listTerminals: async () => ({
				...(await listTerminals()),
				terminalRuntimeId: runtimeId,
				attachmentEpoch: 'epoch',
			}),
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
			terminals: [metadata(secondId, 2), metadata(firstId, 1)],
		});
		const registry = createRegistry();

		await expect(registry.list()).rejects.toThrow('offline');
		expect(onSuccessfulList).not.toHaveBeenCalled();
		await registry.list();

		expect(onSuccessfulList).toHaveBeenCalledOnce();
		expect(onSuccessfulList).toHaveBeenCalledWith([firstId, secondId], 'local');

		transport.options.onMessage({
			type: 'terminal-status',
			terminal: metadata(firstId, 1, { processStatus: 'exited' }),
		});
		expect(onSuccessfulList).toHaveBeenCalledOnce();
	});

	it('keeps runtime lookup pure until creation is explicitly requested', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
		});
		const registry = createRegistry();
		await registry.list();

		expect(registry.runtimeIfPresent(firstId)).toBeNull();
		const firstRequest = registry.ensureRuntime(firstId);
		const secondRequest = registry.ensureRuntime(firstId);
		expect(firstRequest).toBe(secondRequest);
		expect(registry.sessions[firstId].runtimeState).toBe('loading');
		const runtime = await firstRequest;

		expect(registry.runtimeIfPresent(firstId)).toBe(runtime);
		expect(registry.sessions[firstId].runtimeState).toBe('ready');
		expect(await registry.ensureRuntime(firstId)).toBe(runtime);
	});

	it('retries a rejected runtime module load', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
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

		await expect(registry.ensureRuntime(firstId)).rejects.toThrow('Terminal chunk unavailable');
		const runtime = await registry.ensureRuntime(firstId);

		expect(runtime).toBeInstanceOf(FakeRuntime);
		expect(loadRuntime).toHaveBeenCalledTimes(2);
		expect(registry.sessions[firstId].runtimeState).toBe('ready');
	});

	it('reloads the page when a browser-cached terminal module import fails', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
		});
		const reloadApplication = vi.fn();
		const loadRuntime = vi
			.fn<() => Promise<TerminalRuntimeModule>>()
			.mockRejectedValue(new ModuleImportError(new Error('Terminal chunk unavailable')));
		const registry = createRegistry({ createRuntime: null, loadRuntime, reloadApplication });
		await registry.list();
		transport.status = 'connected';

		await registry.attach(firstId, 'restore');
		expect(registry.sessions[firstId]).toMatchObject({
			attachmentState: 'unavailable',
			runtimeState: 'failed',
			runtimeError: 'Terminal chunk unavailable',
			runtimeErrorRequiresPageReload: true,
		});

		registry.reattach(firstId);

		expect(reloadApplication).toHaveBeenCalledOnce();
		expect(loadRuntime).toHaveBeenCalledOnce();
		expect(transport.sent).toEqual([]);
	});

	it('loads one runtime before sending the latest attachment request', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
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

		const restore = registry.attach(firstId, 'restore');
		const takeover = registry.attach(firstId, 'takeover');
		const surfaceRuntime = registry.ensureRuntime(firstId);
		expect(transport.sent).toEqual([]);
		expect(createRuntime).toHaveBeenCalledOnce();
		expect(registry.sessions[firstId].runtimeState).toBe('loading');
		transport.options.onMessage({
			type: 'terminal-status',
			terminal: metadata(firstId, 1, { latestOutputSequence: 4 }),
		});
		transport.options.onMessage({
			type: 'terminal-replay-truncated',
			terminalId: firstId,
			firstSequence: 5,
		});
		if (!runtimeOptions) throw new Error('Expected terminal runtime options');
		const runtime = new FakeRuntime(runtimeOptions) as unknown as TerminalRuntime;
		runtimeCreation.resolve(runtime);

		await Promise.all([restore, takeover]);
		expect(await surfaceRuntime).toBe(runtime);
		expect(registry.sessions[firstId].runtimeState).toBe('ready');
		expect(transport.sent).toEqual([
			{
				type: 'terminal-attach',
				terminalId: firstId,
				clientId: 'client-1',
				afterSequence: 0,
				intent: 'takeover',
				attachmentId: expect.any(String),
				attachmentEpoch: 'epoch',
			},
		]);
	});

	it('waits for concurrent List reconciliation before attaching a loaded runtime', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata(firstId, 1)],
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

		const attachment = registry.attach(firstId, 'restore');
		const reconciliation = registry.list();
		runtimeCreation.resolve();
		await Promise.resolve();

		expect(transport.sent).toEqual([]);
		pendingList.resolve({ success: true, terminals: [metadata(firstId, 1)] });
		await Promise.all([attachment, reconciliation]);

		expect(registry.sessions[firstId]).toMatchObject({
			attachmentState: 'connecting',
			runtimeState: 'ready',
		});
		expect(transport.sent).toEqual([
			{
				type: 'terminal-attach',
				terminalId: firstId,
				clientId: 'client-1',
				afterSequence: 0,
				intent: 'restore',
				attachmentId: expect.any(String),
				attachmentEpoch: 'epoch',
			},
		]);
	});

	it('leaves attachment retryable when concurrent List reconciliation fails', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata(firstId, 1)],
			})
			.mockImplementationOnce(() => pendingList.promise)
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata(firstId, 1)],
			});
		const runtimeCreation = deferred<void>();
		const registry = createRegistry({
			createRuntime: async (options) => {
				await runtimeCreation.promise;
				return new FakeRuntime(options) as unknown as TerminalRuntime;
			},
		});
		await registry.list();
		transport.status = 'connected';

		const attachment = registry.attach(firstId, 'restore');
		const reconciliation = registry.list();
		const reconciliationFailure = expect(reconciliation).rejects.toThrow('List failed');
		runtimeCreation.resolve();
		pendingList.reject(new Error('List failed'));

		await reconciliationFailure;
		await attachment;

		expect(registry.sessions[firstId]).toMatchObject({
			attachmentState: 'detached',
			runtimeState: 'ready',
		});
		expect(transport.sent).toEqual([]);

		registry.reattach(firstId);
		await vi.waitFor(() => expect(transport.sent).toHaveLength(1));

		expect(listTerminals).toHaveBeenCalledTimes(3);
		expect(registry.listStatus).toBe('ready');
		expect(transport.sent).toEqual([
			{
				type: 'terminal-attach',
				terminalId: firstId,
				clientId: 'client-1',
				afterSequence: 0,
				intent: 'takeover',
				attachmentId: expect.any(String),
				attachmentEpoch: 'epoch',
			},
		]);
	});

	it('keeps failed runtime presentation active and retries attachment', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
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

		await registry.attach(firstId, 'restore');
		expect(transport.sent).toEqual([]);
		expect(registry.sessions[firstId]).toMatchObject({
			attachmentState: 'unavailable',
			runtimeState: 'failed',
			runtimeError: 'Terminal chunk unavailable',
			runtimeErrorRequiresPageReload: false,
		});
		const bridge = new SurfaceFrameBridge();
		await expect(
			bridge.activate(shouldWaitForTerminalRenderer(registry.sessions[firstId])),
		).resolves.toBeUndefined();

		await registry.attach(firstId, 'takeover');
		expect(createRuntime).toHaveBeenCalledTimes(2);
		expect(registry.sessions[firstId].runtimeState).toBe('ready');
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
			terminals: [metadata(firstId, 1)],
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
		const attachment = registry.attach(firstId, 'restore');
		if (!runtimeOptions) throw new Error('Expected terminal runtime options');
		const runtime = new FakeRuntime(runtimeOptions);

		registry.disposeTerminatedSession(firstId);
		runtimeCreation.resolve(runtime as unknown as TerminalRuntime);
		await attachment;

		expect(runtime.disposeCount).toBe(1);
		expect(registry.runtimeIfPresent(firstId)).toBeNull();
		expect(transport.sent).toEqual([]);
	});

	it('does not publish a superseded runtime after the terminal ID is reused', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
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

		const firstRequest = registry.ensureRuntime(firstId);
		registry.disposeTerminatedSession(firstId);
		listTerminals.mockResolvedValue({ success: true, terminals: [metadata(firstId, 2)] });
		await registry.list();
		const secondRequest = registry.ensureRuntime(firstId);
		const firstRuntime = new FakeRuntime(runtimeOptions[0]);
		const secondRuntime = new FakeRuntime(runtimeOptions[1]);
		firstCreation.resolve(firstRuntime as unknown as TerminalRuntime);
		secondCreation.resolve(secondRuntime as unknown as TerminalRuntime);

		await expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' });
		await expect(secondRequest).resolves.toBe(secondRuntime);
		expect(firstRuntime.disposeCount).toBe(1);
		expect(registry.runtimeIfPresent(firstId)).toBe(secondRuntime);
	});

	it('lists before opening the stream and lists again before restoring attachments', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
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
					terminalId: firstId,
					clientId: 'client-1',
					afterSequence: 0,
					intent: 'restore',
					attachmentId: expect.any(String),
					attachmentEpoch: 'epoch',
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

	it('keeps a delayed initialization failure suspended after logout', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockImplementationOnce(() => pendingList.promise)
			.mockResolvedValue({
				success: true,
				terminals: [metadata(firstId, 1)],
			});
		const registry = createRegistry();

		const initialization = registry.initialize();
		registry.authChanged(false);
		pendingList.reject(new Error('List failed'));
		await initialization;

		expect(registry.listStatus).toBe('failed');
		expect(transport.status).toBe('idle');
		expect(transport.connectCount).toBe(0);
		expect(transport.sent).toEqual([]);

		registry.authChanged(true);
		expect(transport.status).toBe('connecting');
		await transport.open();
		await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
		expect(transport.sent[0]).toMatchObject({
			type: 'terminal-attach',
			terminalId: firstId,
			intent: 'restore',
		});
	});

	it('suspends on logout and reconnects existing sessions after login', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
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

	it('keeps a delayed Reattach reconciliation suspended after logout', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata(firstId, 1)],
			})
			.mockRejectedValueOnce(new Error('List failed'))
			.mockImplementationOnce(() => pendingList.promise)
			.mockResolvedValue({
				success: true,
				terminals: [metadata(firstId, 1)],
			});
		const registry = createRegistry();
		await registry.list();
		transport.status = 'connected';
		await expect(registry.list()).rejects.toThrow('List failed');

		registry.reattach(firstId);
		registry.authChanged(false);
		pendingList.resolve({ success: true, terminals: [metadata(firstId, 1)] });
		await vi.waitFor(() => expect(registry.listStatus).toBe('ready'));

		expect(transport.status).toBe('idle');
		expect(transport.connectCount).toBe(1);
		expect(transport.sent).toEqual([]);

		registry.authChanged(true);
		expect(transport.status).toBe('connecting');
		await transport.open();
		await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
		expect(transport.sent[0]).toMatchObject({
			type: 'terminal-attach',
			terminalId: firstId,
			intent: 'restore',
		});
	});

	it('reconnects waiting-auth transport after authentication refreshes', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
		});
		const registry = createRegistry();
		await registry.initialize();
		transport.status = 'waiting-auth';

		registry.authChanged(true);

		expect(transport.connectCount).toBe(2);
		expect(transport.status).toBe('connecting');
	});

	it('preserves stream updates and creates that arrive after a List snapshot starts', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata(firstId, 1)],
			})
			.mockImplementationOnce(() => pendingList.promise);
		const registry = createRegistry();
		await registry.list();
		transport.status = 'connected';
		await registry.attach(firstId, 'restore');

		const pendingCreate = deferred<{ success: true; terminal: TerminalMetadata }>();
		createTerminal.mockImplementationOnce(() => pendingCreate.promise);
		const creating = registry.create('/workspace/2', 'create-2');
		const reconciliation = registry.list();
		transport.emit({
			type: 'terminal-status',
			terminal: metadata(firstId, 1, {
				processStatus: 'exited',
				exitCode: 7,
			}),
		});
		pendingCreate.resolve({ success: true, terminal: metadata(secondId, 2) });
		await creating;
		pendingList.resolve({
			success: true,
			terminals: [metadata(firstId, 1)],
		});
		await reconciliation;

		expect(registry.sessions[firstId].metadata).toMatchObject({
			processStatus: 'exited',
			exitCode: 7,
		});
		expect(registry.sessions[secondId]?.metadata.terminalId).toBe(secondId);
	});

	it('does not resurrect a locally removed session from an older List snapshot', async () => {
		const pendingList = deferred<{ success: true; terminals: TerminalMetadata[] }>();
		listTerminals
			.mockResolvedValueOnce({
				success: true,
				terminals: [metadata(firstId, 1)],
			})
			.mockImplementationOnce(() => pendingList.promise);
		const registry = createRegistry();
		await registry.list();
		const runtime = (await registry.ensureRuntime(firstId)) as unknown as FakeRuntime;

		const reconciliation = registry.list();
		registry.disposeTerminatedSession(firstId);
		pendingList.resolve({
			success: true,
			terminals: [metadata(firstId, 1)],
		});
		await reconciliation;

		expect(registry.sessions[firstId]).toBeUndefined();
		expect(runtime.disposeCount).toBe(1);
	});

	it('applies rename responses without regressing other session metadata', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [
				metadata(firstId, 1, {
					processStatus: 'exited',
					exitCode: 0,
					latestOutputSequence: 4,
				}),
			],
		});
		renameTerminal.mockResolvedValue({
			success: true,
			terminalId: firstId,
			title: 'Build logs',
		});
		const registry = createRegistry();
		await registry.list();

		await registry.rename(firstId, ' Build logs ');

		expect(renameTerminal).toHaveBeenCalledWith({
			terminalId: firstId,
			title: ' Build logs ',
		});
		expect(registry.sessions[firstId].metadata).toMatchObject({
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
				terminals: [metadata(firstId, 1)],
			})
			.mockImplementationOnce(() => pendingList.promise);
		renameTerminal.mockResolvedValue({
			success: true,
			terminalId: firstId,
			title: 'Build logs',
		});
		const registry = createRegistry();
		await registry.list();

		const reconciliation = registry.list();
		await registry.rename(firstId, 'Build logs');
		pendingList.resolve({
			success: true,
			terminals: [metadata(firstId, 1)],
		});
		await reconciliation;

		expect(registry.sessions[firstId].metadata.title).toBe('Build logs');
	});

	it('leaves the current title unchanged when rename fails', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1, { title: 'Current' })],
		});
		renameTerminal.mockRejectedValue(new Error('Rename failed'));
		const registry = createRegistry();
		await registry.list();

		await expect(registry.rename(firstId, 'Next')).rejects.toThrow('Rename failed');

		expect(registry.sessions[firstId].metadata.title).toBe('Current');
	});

	it('applies title updates from terminal status broadcasts', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
		});
		const registry = createRegistry();
		await registry.list();
		transport.status = 'connected';
		await registry.attach(firstId, 'restore');

		transport.emit({
			type: 'terminal-status',
			terminal: metadata(firstId, 1, { title: 'Remote title' }),
		});

		expect(registry.sessions[firstId].metadata.title).toBe('Remote title');
	});

	it('disposes a remotely terminated session and notifies workspace placement', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1)],
		});
		const registry = createRegistry();
		await registry.list();
		const runtime = (await registry.ensureRuntime(firstId)) as unknown as FakeRuntime;
		transport.status = 'connected';
		await registry.attach(firstId, 'restore');

		transport.emit({ type: 'terminal-terminated', terminalId: firstId });

		expect(registry.sessions[firstId]).toBeUndefined();
		expect(runtime.disposeCount).toBe(1);
		expect(onSessionTerminated).toHaveBeenCalledWith(firstId);
		expect(transport.suspendCount).toBe(1);
		expect(transport.status).toBe('idle');
	});

	it('lets the server arbitrate restore for a session that was already attached', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1, { attachmentStatus: 'attached' })],
		});
		const registry = createRegistry();
		await registry.list();
		transport.status = 'connected';
		await transport.open();

		await vi.waitFor(() =>
			expect(transport.sent).toEqual([
				{
					type: 'terminal-attach',
					terminalId: firstId,
					clientId: 'client-1',
					afterSequence: 0,
					intent: 'restore',
					attachmentId: expect.any(String),
					attachmentEpoch: 'epoch',
				},
			]),
		);
		transport.emit({
			type: 'terminal-error',
			code: 'terminal-takeover-required',
			message: 'Terminal is attached in another browser tab.',
			terminalId: firstId,
		});
		expect(registry.sessions[firstId].attachmentState).toBe('taken-over');
	});

	it('creates with the caller request ID and attaches without creating a second PTY', async () => {
		const terminal = metadata(firstId, 1);
		listTerminals
			.mockResolvedValueOnce({ success: true, terminals: [] })
			.mockResolvedValue({ success: true, terminals: [terminal] });
		createTerminal.mockResolvedValue({ success: true, terminal });
		const registry = createRegistry();

		await expect(registry.create('/workspace', 'request-1')).resolves.toBe(firstId);
		expect(createTerminal).toHaveBeenCalledWith({
			requestId: 'request-1',
			nodeId: 'local',
			expectedTerminalRuntimeId: runtimeId,
			requestedInitialWorkingDirectory: '/workspace',
		});
		expect(registry.pendingCreates).toEqual({});
		expect(transport.sent).toEqual([]);

		await transport.open();
		await vi.waitFor(() =>
			expect(transport.sent[0]).toMatchObject({
				type: 'terminal-attach',
				terminalId: firstId,
				intent: 'restore',
			}),
		);
	});

	it('opens the terminal stream after creating the first session', async () => {
		const terminal = metadata(firstId, 1);
		createTerminal.mockResolvedValue({ success: true, terminal });
		const registry = createRegistry();

		await registry.create('/workspace', 'request-1');

		expect(transport.connectCount).toBe(1);
		expect(transport.status).toBe('connecting');
		expect(registry.sessions[firstId].attachmentState).toBe('detached');
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
			terminals: [metadata(firstId, 1, { latestOutputSequence: 3 })],
		});
		const registry = createRegistry();
		await registry.list();
		const runtime = (await registry.ensureRuntime(firstId)) as unknown as FakeRuntime;
		transport.status = 'connected';
		await registry.attach(firstId, 'restore');
		transport.emit({
			type: 'terminal-replay-truncated',
			terminalId: firstId,
			firstSequence: 2,
		});
		transport.emit({
			type: 'terminal-attached',
			terminal: metadata(firstId, 1, { latestOutputSequence: 3 }),
			replay: [
				{ sequence: 1, data: 'old' },
				{ sequence: 2, data: 'two' },
				{ sequence: 3, data: 'three' },
			],
		});
		transport.emit({
			type: 'terminal-output',
			terminalId: firstId,
			sequence: 3,
			data: 'duplicate',
		});
		transport.emit({
			type: 'terminal-taken-over',
			terminalId: firstId,
			replacementClientId: 'client-2',
		});
		transport.sent = [];
		await transport.open();

		const session = registry.sessions[firstId];
		runtime.options.onInput('blocked');
		runtime.options.onResize({ cols: 100, rows: 30 });
		expect(session.replayTruncatedAt).toBe(2);
		expect(session.lastReceivedSequence).toBe(3);
		expect(session.attachmentState).toBe('taken-over');
		expect(runtime.writes).toEqual(['two', 'three']);
		expect(transport.sent).toEqual([]);

		await registry.attach(firstId, 'takeover');
		transport.emit({
			type: 'terminal-attached',
			terminal: metadata(firstId, 1, { latestOutputSequence: 3 }),
			replay: [],
		});
		transport.sent = [];
		runtime.options.onInput('allowed');
		runtime.options.onResize({ cols: 120, rows: 40 });
		expect(transport.sent).toEqual([
			{
				type: 'terminal-input',
				terminalId: firstId,
				data: 'allowed',
				attachmentId: expect.any(String),
			},
			{
				type: 'terminal-resize',
				terminalId: firstId,
				cols: 120,
				rows: 40,
				attachmentId: expect.any(String),
			},
		]);
	});

	it('applies encoded replay batches and completes fragmented output atomically', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1, { latestOutputSequence: 2 })],
		});
		const registry = createRegistry();
		await registry.list();
		const runtime = (await registry.ensureRuntime(firstId)) as unknown as FakeRuntime;
		transport.status = 'connected';
		await registry.attach(firstId, 'restore');
		transport.emit({
			type: 'terminal-attached',
			terminal: metadata(firstId, 1, { latestOutputSequence: 2 }),
			replay: [],
		});
		transport.emit({
			type: 'terminal-replay-batch',
			terminalId: firstId,
			chunks: [{ sequence: 1, dataBase64: 'b25l' }],
		});
		transport.emit({
			type: 'terminal-output-fragment',
			terminalId: firstId,
			sequence: 2,
			fragmentIndex: 0,
			fragmentCount: 2,
			dataBase64: 'dHdv',
		});

		expect(runtime.writes).toEqual(['one']);
		expect(registry.sessions[firstId].lastReceivedSequence).toBe(1);

		transport.emit({
			type: 'terminal-output-fragment',
			terminalId: firstId,
			sequence: 2,
			fragmentIndex: 1,
			fragmentCount: 2,
			dataBase64: '',
		});
		expect(runtime.writes).toEqual(['one', 'two']);
		expect(registry.sessions[firstId].lastReceivedSequence).toBe(2);
	});

	it('terminates explicitly and disposes only the selected runtime', async () => {
		listTerminals.mockResolvedValue({
			success: true,
			terminals: [metadata(firstId, 1), metadata(secondId, 2)],
		});
		const registry = createRegistry();
		await registry.list();
		const first = (await registry.ensureRuntime(firstId)) as unknown as FakeRuntime;
		const second = (await registry.ensureRuntime(secondId)) as unknown as FakeRuntime;

		await registry.requestTermination(firstId, 'terminate-1');
		expect(terminateTerminal).toHaveBeenCalledWith({
			terminalId: firstId,
			requestId: 'terminate-1',
		});
		expect(first.disposeCount).toBe(0);
		expect(registry.sessions[firstId]).toBeDefined();

		registry.disposeTerminatedSession(firstId);
		expect(first.disposeCount).toBe(1);
		expect(second.disposeCount).toBe(0);
		expect(registry.sessions[firstId]).toBeUndefined();
		expect(registry.sessions[secondId]).toBeDefined();
	});
});
