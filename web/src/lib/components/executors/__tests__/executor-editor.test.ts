import { describe, expect, it, vi } from 'vitest';
import type * as api from '$lib/api/executors';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import type { ExecutorConnection, ExecutorSnapshot } from '$shared/executors';
import { ExecutorEditor } from '../executor-editor.svelte.ts';

const connection = {
	connectionUrl: `wss://example.test/executor/${remoteExecutor.id}#secret=synthetic`,
	allowInsecureDevelopment: false,
	allowUnverifiedTls: false,
} satisfies ExecutorConnection;

function fixture() {
	const read = vi.fn<typeof api.getExecutors>(async () => [localExecutor, remoteExecutor]);
	const executors = new ExecutorsStore(read);
	executors.applySnapshot([localExecutor, remoteExecutor]);
	const transport = {
		getExecutors: read,
		createExecutor: vi.fn<typeof api.createExecutor>(async () => ({ id: remoteExecutor.id, ...connection })),
		getExecutorConnection: vi.fn<typeof api.getExecutorConnection>(async () => connection),
		updateExecutor: vi.fn<typeof api.updateExecutor>(async () => [localExecutor, remoteExecutor]),
		removeExecutor: vi.fn<typeof api.removeExecutor>(async () => [localExecutor]),
	} satisfies typeof api;
	return { executors, read, transport, editor: new ExecutorEditor(executors, transport) };
}

describe('ExecutorEditor', () => {
	it('changes the CLI grant without rewriting enable or connection state', async () => {
		const { editor, transport } = fixture();
		await editor.edit(remoteExecutor);
		expect(editor.allowControllerCli).toBe(false);
		editor.allowControllerCli = true;
		await editor.save();
		expect(transport.updateExecutor).toHaveBeenLastCalledWith(remoteExecutor.id, { label: remoteExecutor.label, allowControllerCli: true });
		await editor.save();
		expect(transport.updateExecutor).toHaveBeenLastCalledWith(remoteExecutor.id, { label: remoteExecutor.label });
		editor.clear();
		expect(editor.allowControllerCli).toBe(false);
	});
	it('refreshes creation after a held pre-create snapshot without WebSocket delivery', async () => {
		const { editor, executors, read } = fixture();
		const response = Promise.withResolvers<readonly ExecutorSnapshot[]>();
		read.mockReturnValueOnce(response.promise);
		const discovery = executors.refresh();
		editor.label = 'New worker';
		const saving = editor.save();
		response.resolve([localExecutor]);
		await discovery;
		expect(await saving).toBe(true);
		expect(read).toHaveBeenCalledTimes(2);
		expect(executors.get(remoteExecutor.id)).toEqual(remoteExecutor);
	});

	it('creates an inbound executor and keeps its connection URL only in editor state', async () => {
		const { editor, executors, transport } = fixture();
		editor.label = ' Build Machine ';
		expect(await editor.save()).toBe(true);
		expect(transport.createExecutor).toHaveBeenCalledWith({
			label: 'Build Machine', direction: 'executor-connects', allowInsecureDevelopment: false, allowUnverifiedTls: false,
			allowControllerCli: false,
		});
		expect(editor.id).toBe(remoteExecutor.id);
		expect(editor.connectionUrl).toBe(connection.connectionUrl);
		expect(JSON.stringify(executors.executors)).not.toContain('secret');
		editor.clear();
		expect(editor.connectionUrl).toBe('');
	});

	it('passes a pasted listener URL through the outbound creation contract', async () => {
		const { editor, transport } = fixture();
		editor.label = 'Worker';
		editor.direction = 'controller-connects';
		editor.connectionUrl = 'ws://worker.test:1234/executor#secret=synthetic';
		editor.allowInsecureDevelopment = true;
		await editor.save();
		expect(transport.createExecutor).toHaveBeenCalledWith({
			label: 'Worker', direction: 'controller-connects', allowInsecureDevelopment: true, allowUnverifiedTls: false,
			allowControllerCli: false,
			connectionUrl: 'ws://worker.test:1234/executor#secret=synthetic',
		});
	});

	it('omits a connection edit for a rename', async () => {
		const { editor, transport } = fixture();
		await editor.edit(remoteExecutor);
		editor.label = 'Renamed';
		await editor.save();
		expect(transport.updateExecutor).toHaveBeenCalledWith(remoteExecutor.id, {
			label: 'Renamed',
		});
		editor.connectionUrl = connection.connectionUrl.replace('example.test', 'controller.test');
		await editor.save();
		expect(transport.updateExecutor).toHaveBeenLastCalledWith(remoteExecutor.id, {
			label: 'Renamed',
			connection: { direction: 'executor-connects', connectionUrl: editor.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: false },
		});
		editor.enabled = false;
		await editor.save();
		expect(transport.updateExecutor).toHaveBeenLastCalledWith(remoteExecutor.id, { label: 'Renamed', enabled: false });
	});

	it('persists certificate opt-out only for outbound connections and clears it with the editor', async () => {
		const { editor, transport } = fixture();
		await editor.edit({ ...remoteExecutor, direction: 'controller-connects' });
		expect(editor.allowUnverifiedTls).toBe(false);
		editor.allowUnverifiedTls = true;
		await editor.save();
		expect(transport.updateExecutor).toHaveBeenLastCalledWith(remoteExecutor.id, {
			label: remoteExecutor.label,
			connection: { direction: 'controller-connects', connectionUrl: editor.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true },
		});
		editor.direction = 'executor-connects';
		await editor.save();
		expect(transport.updateExecutor.mock.lastCall?.[1].connection?.allowUnverifiedTls).toBe(false);
		editor.clear();
		expect(editor.allowUnverifiedTls).toBe(false);
	});

	it('does not restore a secret after the editor closes during reveal', async () => {
		const { editor, transport } = fixture();
		const response = Promise.withResolvers<ExecutorConnection>();
		transport.getExecutorConnection.mockReturnValue(response.promise);
		const pending = editor.edit(remoteExecutor);
		editor.clear();
		response.resolve(connection);
		await pending;
		expect(editor.id).toBeNull();
		expect(editor.connectionUrl).toBe('');
		expect(editor.busy).toBe(false);
	});

	it('does not replace newer pushed readiness with an old save response', async () => {
		const { editor, transport, executors, read } = fixture();
		await editor.edit(remoteExecutor);
		const response = Promise.withResolvers<readonly ExecutorSnapshot[]>();
		transport.updateExecutor.mockReturnValue(response.promise);
		const pending = editor.save();
		executors.applySnapshot([localExecutor, remoteExecutor]);
		response.resolve([localExecutor, { ...remoteExecutor, availability: 'offline' }]);
		await pending;
		expect(read).toHaveBeenCalledTimes(1);
		expect(executors.isReady(remoteExecutor.id)).toBe(true);
	});

	it('requires delete confirmation and preserves errors without claiming deletion', async () => {
		const { editor, transport, executors } = fixture();
		await editor.edit(remoteExecutor);
		expect(await editor.remove()).toBe(false);
		expect(transport.removeExecutor).not.toHaveBeenCalled();
		editor.confirmDelete = true;
		transport.removeExecutor.mockRejectedValueOnce(new Error('Executor is in use'));
		expect(await editor.remove()).toBe(false);
		expect(editor.error).toBe('Executor is in use');
		expect(executors.get(remoteExecutor.id)).toBeDefined();
		expect(await editor.remove()).toBe(true);
		expect(executors.get(remoteExecutor.id)).toBeUndefined();
		expect(editor.connectionUrl).toBe('');
	});
});
