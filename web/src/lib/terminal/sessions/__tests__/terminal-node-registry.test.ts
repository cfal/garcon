import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	TerminalRegistry,
	type TerminalSessionRuntime,
	type TerminalTransportPort,
} from '../terminal-registry.svelte.js';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';
import type {
	TerminalListResponse,
	TerminalMetadata,
	TerminalStreamClientMessage,
} from '$shared/terminal';
import type { TerminalTransportOptions } from '$lib/ws/terminal-transport.svelte.js';
import { TerminalTransport } from '$lib/ws/terminal-transport.svelte.js';
import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';
import { ApiError } from '$lib/api/client.js';
import { parseTerminalStreamClientMessage } from '$shared/terminal';

const remoteId = '00000000-0000-4000-8000-000000000001';
const runtimeId = '00000000-0000-4000-8000-000000000002';
const replacementRuntimeId = '00000000-0000-4000-8000-000000000003';
const registries: TerminalRegistry[] = [];
afterEach(() => {
	for (const registry of registries.splice(0)) registry.destroy();
	vi.useRealTimers();
});

function node(
	id: string,
	availability: ExecutionNodeSnapshot['availability'] = 'ready',
	label = id === 'local' ? 'Local' : 'Build Server',
): ExecutionNodeSnapshot {
	return {
		id,
		label,
		kind: id === 'local' ? 'local' : 'remote',
		enabled: true,
		direction: id === 'local' ? null : 'node-connects',
		availability,
		instanceId: null,
		projectBasePath: '/project',
		lastError: null,
		machineServices: { terminals: true, files: true, git: false },
	};
}
function terminal(nodeId: string, sequence = 1, runtime = runtimeId): TerminalMetadata {
	return {
		terminalId: `${nodeId}/${runtime}/00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
		title: null,
		displaySequence: sequence,
		initialWorkingDirectory: '/project',
		processStatus: 'running',
		attachmentStatus: 'detached',
		createdAt: '2026-01-01T00:00:00.000Z',
		exitCode: null,
		latestOutputSequence: 0,
	};
}
const inventory = (terminals: TerminalMetadata[], runtime = runtimeId): TerminalListResponse => ({
	success: true,
	terminalRuntimeId: runtime,
	attachmentEpoch: 'epoch',
	terminals,
});

function setup(options: { realTransport?: boolean } = {}) {
	const nodes = new ExecutionNodesStore();
	nodes.applySnapshot([node('local'), node(remoteId)]);
	const list = vi.fn(async (nodeId = 'local') => inventory([terminal(nodeId)]));
	const create = vi.fn(async () => ({ success: true as const, terminal: terminal(remoteId, 2) }));
	const write = vi.fn();
	const dispose = vi.fn();
	const renderer = {
		write,
		dispose,
		resendSize() {},
		applyTheme() {},
		prepareRendererTransfer() {},
		attach: () => ({ lease: 1, ready: Promise.resolve() }),
		park() {},
		scheduleFit() {},
		focus() {},
		pasteFromClipboard: async () => true,
		applyFontSize() {},
		clipboardMessage: '',
		sendToolbarKey() {},
		inputControls: { ctrlMode: 'inactive', altMode: 'inactive', toggleModifier() {} },
	} satisfies TerminalSessionRuntime;
	const sent: TerminalStreamClientMessage[] = [];
	const connection = {
		isConnected: true,
		sendMessage(message) {
			const parsed = parseTerminalStreamClientMessage(message);
			if (parsed) sent.push(parsed);
			return true;
		},
		addMessageConsumer: () => () => {},
		onConnectionChange: () => () => {},
	} satisfies PrimaryWsConnectionPort;
	let callbacks!: TerminalTransportOptions;
	const transport = {
		status: 'connected' as const,
		connect() {},
		send(message: TerminalStreamClientMessage) {
			sent.push(message);
			return true;
		},
		suspend() {},
		destroy() {},
	} satisfies TerminalTransportPort;
	const registry = new TerminalRegistry({
		nodes,
		connection,
		getClientId: () => 'browser',
		listTerminals: list,
		createTerminal: create,
		createTransport: (callbacksOptions) => {
			callbacks = callbacksOptions;
			return options.realTransport ? new TerminalTransport(callbacksOptions) : transport;
		},
		createRuntime: () => renderer,
	});
	registries.push(registry);
	return { registry, nodes, list, create, sent, callbacks, renderer, write, dispose };
}

describe('node-qualified terminal registry', () => {
	it('keeps Local first and preserves configured remote host order', () => {
		const { registry, nodes } = setup();
		const otherRemoteId = '00000000-0000-4000-8000-000000000004';
		nodes.applySnapshot([node(otherRemoteId), node('local'), node(remoteId, 'offline')]);
		expect(registry.hosts.map((host) => host.id)).toEqual(['local', otherRemoteId, remoteId]);
		expect(registry.hosts[2].available).toBe(false);
	});

	it.each(['before inventory', 'after inventory'])(
		'fences obsolete create results resolving %s',
		async (ordering) => {
			const { registry, list, create, sent } = setup();
			await registry.initialize();
			const creation = Promise.withResolvers<Awaited<ReturnType<typeof create>>>();
			create.mockImplementationOnce(() => creation.promise);
			const creating = registry.create('/project', 'in-flight-create', remoteId);
			const oldId = terminal(remoteId, 2).terminalId;
			const replacement = Promise.withResolvers<TerminalListResponse>();
			list.mockImplementationOnce(() => replacement.promise);
			const listing = registry.list(remoteId);
			if (ordering === 'before inventory') {
				creation.resolve({ success: true, terminal: terminal(remoteId, 2) });
				await expect(creating).resolves.toBe(oldId);
			}
			replacement.resolve(
				inventory([terminal(remoteId, 1, replacementRuntimeId)], replacementRuntimeId),
			);
			await listing;
			if (ordering === 'after inventory') {
				creation.resolve({ success: true, terminal: terminal(remoteId, 2) });
				await expect(creating).rejects.toMatchObject({ errorCode: 'terminal-runtime-changed' });
			}
			expect(registry.nodeInventories[remoteId].runtimeId).toBe(replacementRuntimeId);
			expect(registry.sessions[oldId]).toBeUndefined();
			expect(registry.sessions[terminal(remoteId).terminalId]).toBeUndefined();
			expect(
				registry.sessions[terminal(remoteId, 1, replacementRuntimeId).terminalId],
			).toBeDefined();
			expect(registry.sessions[terminal('local').terminalId]).toBeDefined();
			expect(sent.some((message) => message.terminalId === oldId)).toBe(false);
		},
	);

	it('retries a failed ready-node inventory after partial transport reconciliation succeeds', async () => {
		vi.useFakeTimers();
		const { registry, list, sent } = setup({ realTransport: true });
		let remoteUnavailable = true;
		list.mockImplementation(async (id = 'local') => {
			if (id === remoteId && remoteUnavailable) throw new Error('Transient inventory failure');
			return inventory([terminal(id)]);
		});
		await registry.initialize();
		await vi.waitFor(() => expect(registry.transportStatus).toBe('connected'));
		expect(registry.sessions[terminal('local').terminalId]).toBeDefined();
		expect(registry.nodeInventories[remoteId].status).toBe('failed');
		const localCalls = list.mock.calls.filter(([id]) => id === 'local').length;
		remoteUnavailable = false;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(registry.nodeInventories[remoteId].status).toBe('ready');
		expect(registry.sessions[terminal(remoteId).terminalId]).toBeDefined();
		expect(sent).toContainEqual(
			expect.objectContaining({
				type: 'terminal-attach',
				terminalId: terminal(remoteId).terminalId,
			}),
		);
		expect(list.mock.calls.filter(([id]) => id === 'local')).toHaveLength(localCalls);
	});

	it.each(['destroy', 'logout', 'offline'])('does not retry inventory after %s', async (action) => {
		vi.useFakeTimers();
		const { registry, list, nodes } = setup();
		list.mockImplementation(async (id = 'local') => {
			if (id === remoteId) throw new Error('Transient inventory failure');
			return inventory([terminal(id)]);
		});
		await registry.initialize();
		const calls = list.mock.calls.length;
		if (action === 'destroy') registry.destroy();
		else if (action === 'logout') registry.authChanged(false);
		else nodes.applySnapshot([node('local'), node(remoteId, 'offline')]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(list).toHaveBeenCalledTimes(calls);
	});

	it('resumes failed-node inventory retries after login when successful hosts are empty', async () => {
		vi.useFakeTimers();
		const { registry, list, sent } = setup({ realTransport: true });
		const local = Promise.withResolvers<TerminalListResponse>();
		let remoteUnavailable = true;
		list.mockImplementation(async (id = 'local') => {
			if (id === 'local') return local.promise;
			if (remoteUnavailable) throw new Error('Transient inventory failure');
			return inventory([terminal(id)]);
		});
		const initializing = registry.initialize();
		await vi.waitFor(() => expect(registry.nodeInventories[remoteId].status).toBe('failed'));
		local.resolve(inventory([]));
		await initializing;
		expect(registry.listStatus).toBe('ready');
		expect(registry.sessions).toEqual({});
		registry.authChanged(false);
		const calls = list.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(list).toHaveBeenCalledTimes(calls);

		remoteUnavailable = false;
		registry.authChanged(true);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(registry.nodeInventories[remoteId].status).toBe('ready');
		expect(registry.sessions[terminal(remoteId).terminalId]).toBeDefined();
		expect(sent).toContainEqual(
			expect.objectContaining({
				type: 'terminal-attach',
				terminalId: terminal(remoteId).terminalId,
			}),
		);
	});

	it('rejects unqualified stream events and cancels gap recovery when the node goes offline', async () => {
		const { registry, nodes, sent, callbacks, write } = setup();
		await registry.initialize();
		const id = terminal(remoteId).terminalId;
		await registry.attach(id, 'restore');
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			sequence: 1,
			data: 'unqualified',
		});
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			attachmentId: sent.at(-1)!.attachmentId,
			sequence: 2,
			data: 'gap',
		});
		nodes.applySnapshot([node('local'), node(remoteId, 'offline')]);
		await Promise.resolve();
		expect(sent.filter((message) => message.type === 'terminal-attach')).toHaveLength(1);
		expect(registry.sessions[id].attachmentState).toBe('unavailable');
		expect(write).not.toHaveBeenCalled();
	});

	it('does not advance the output cursor when renderer admission fails', async () => {
		const { registry, sent, callbacks, write } = setup();
		await registry.initialize();
		const id = terminal(remoteId).terminalId;
		await registry.attach(id, 'restore');
		write.mockImplementationOnce(() => {
			throw new Error('Renderer full');
		});
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			attachmentId: sent.at(-1)!.attachmentId,
			sequence: 1,
			data: 'replay later',
		});
		expect(registry.sessions[id].lastReceivedSequence).toBe(0);
		expect(registry.sessions[id].attachmentState).toBe('unavailable');
		expect(sent.at(-1)?.type).toBe('terminal-detach');
	});

	it('refreshes the admission epoch on explicit reattach', async () => {
		const { registry, sent, list } = setup();
		await registry.initialize();
		list.mockResolvedValueOnce({
			...inventory([terminal(remoteId)]),
			attachmentEpoch: 'fresh-epoch',
		});
		await registry.attach(terminal(remoteId).terminalId, 'takeover');
		expect(sent.at(-1)).toMatchObject({ type: 'terminal-attach', attachmentEpoch: 'fresh-epoch' });
	});

	it('retains remote history on offline lists and catches rapid node loss/ready without browser reconnect', async () => {
		const { registry, nodes, sent, callbacks, write, dispose } = setup();
		await registry.initialize();
		const id = terminal(remoteId).terminalId;
		await registry.attach(id, 'restore');
		const old = sent.at(-1)!;
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			attachmentId: old.attachmentId,
			sequence: 1,
			data: 'before',
		});
		nodes.applySnapshot([
			node('local'),
			{
				...node(remoteId, 'offline'),
				machineServices: { files: false, git: false, terminals: false },
			},
		]);
		expect(registry.sessions[id].attachmentState).toBe('unavailable');
		await registry.list('local');
		expect(registry.sessions[id].lastReceivedSequence).toBe(1);
		nodes.applySnapshot([node('local'), node(remoteId)]);
		await vi.waitFor(() =>
			expect(
				sent.filter((message) => message.type === 'terminal-attach' && message.terminalId === id),
			).toHaveLength(2),
		);
		const replacement = sent.at(-1)!;
		expect(replacement).toMatchObject({ terminalId: id, afterSequence: 1 });
		expect(replacement.attachmentId).not.toBe(old.attachmentId);
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			attachmentId: old.attachmentId,
			sequence: 2,
			data: 'stale',
		});
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			attachmentId: replacement.attachmentId,
			sequence: 2,
			data: 'current',
		});
		expect(write.mock.calls).toEqual([['before'], ['current']]);
		expect(dispose).not.toHaveBeenCalled();
	});

	it('fences a delayed pre-disconnect list across a new authoritative inventory', async () => {
		const { registry, nodes, list } = setup();
		await registry.initialize();
		const old = Promise.withResolvers<TerminalListResponse>();
		list.mockImplementationOnce(() => old.promise);
		const stale = registry.list(remoteId);
		nodes.applySnapshot([node('local'), node(remoteId, 'offline')]);
		nodes.applySnapshot([node('local'), node(remoteId)]);
		await vi.waitFor(() => expect(registry.nodeInventories[remoteId].status).toBe('ready'));
		old.resolve(inventory([]));
		await stale;
		expect(registry.sessions[terminal(remoteId).terminalId]).toBeDefined();
		expect(registry.sessions[terminal('local').terminalId]).toBeDefined();
	});

	it('limits creation per host and updates default labels without replacing renderers', async () => {
		const { registry, nodes, list, renderer } = setup();
		list.mockImplementation(async (id) =>
			inventory(
				Array.from({ length: id === 'local' ? 8 : 1 }, (_, index) => terminal(id, index + 1)),
			),
		);
		await registry.initialize();
		expect(registry.canCreate('local')).toBe(false);
		expect(registry.canCreate(remoteId)).toBe(true);
		const metadata = terminal(remoteId);
		expect(await registry.ensureRuntime(metadata.terminalId)).toBe(renderer);
		nodes.applySnapshot([node('local'), node(remoteId, 'ready', 'Renamed Host')]);
		expect(registry.displayName(metadata)).toBe('Renamed Host 1');
		expect(registry.displayName({ ...metadata, title: 'Build logs' })).toBe('Build logs');
		expect(await registry.ensureRuntime(metadata.terminalId)).toBe(renderer);
	});

	it('keeps ambiguous create identity, rejects retargeting and reconciles runtime replacement', async () => {
		const { registry, create, list } = setup();
		await registry.initialize();
		create.mockRejectedValueOnce(new ApiError(503, 'Unknown outcome', 'terminal-outcome-unknown'));
		await expect(registry.create('/project', 'request', remoteId)).rejects.toThrow(
			'Unknown outcome',
		);
		expect(registry.pendingCreates.request).toMatchObject({
			nodeId: remoteId,
			terminalRuntimeId: runtimeId,
		});
		await expect(registry.create('/other', 'request', remoteId)).rejects.toThrow('cannot change');
		list.mockResolvedValue({ ...inventory([]), terminalRuntimeId: crypto.randomUUID() });
		await registry.list(remoteId);
		await expect(registry.create('/project', 'request', remoteId)).rejects.toThrow();
		expect(create).toHaveBeenCalledOnce();
	});

	it('retries sequence gaps once and ignores the retired attachment', async () => {
		const { registry, sent, callbacks, write } = setup();
		await registry.initialize();
		const id = terminal(remoteId).terminalId;
		await registry.attach(id, 'restore');
		const old = sent.at(-1)!;
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			attachmentId: old.attachmentId,
			sequence: 2,
			data: 'gap',
		});
		expect(registry.sessions[id].lastReceivedSequence).toBe(0);
		await vi.waitFor(() => expect(sent.at(-1)?.type).toBe('terminal-attach'));
		const next = sent.at(-1)!;
		expect(next.attachmentId).not.toBe(old.attachmentId);
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			attachmentId: old.attachmentId,
			sequence: 1,
			data: 'stale',
		});
		callbacks.onMessage({
			type: 'terminal-output',
			terminalId: id,
			attachmentId: next.attachmentId,
			sequence: 2,
			data: 'still missing',
		});
		await Promise.resolve();
		expect(sent.filter((message) => message.type === 'terminal-attach')).toHaveLength(2);
		expect(write).not.toHaveBeenCalled();
	});
});
