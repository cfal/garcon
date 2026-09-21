import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import {
	localExecutionNode,
	remoteExecutionNode,
} from '$lib/execution-nodes/__tests__/fixtures.js';
import FileNodeBreadcrumb from '../FileNodeBreadcrumb.svelte';

afterEach(cleanup);

it('selects file-capable nodes and keeps unavailable nodes visible but disabled', async () => {
	const remote = {
		...remoteExecutionNode,
		machineServices: { files: true, git: false, terminals: false },
	};
	const offline = {
		...remote,
		id: '33333333-3333-4333-8333-333333333333',
		label: 'Offline worker',
		availability: 'offline' as const,
	};
	const unsupported = {
		...remoteExecutionNode,
		id: '44444444-4444-4444-8444-444444444444',
		label: 'Unsupported worker',
	};
	const snapshot = [localExecutionNode, remote, offline, unsupported];
	const read = vi.fn(async () => snapshot);
	const nodes = new ExecutionNodesStore(read);
	nodes.applySnapshot(snapshot);
	const onSelect = vi.fn();
	render(FileNodeBreadcrumb, { nodes, nodeId: 'local', onSelect });
	await fireEvent.click(screen.getByRole('button', { name: 'Execution node: Local' }));
	expect(read).toHaveBeenCalledOnce();
	expect(screen.getByRole('menuitemradio', { name: 'Local' }).getAttribute('aria-checked')).toBe(
		'true',
	);
	expect(
		screen.getByRole('menuitemradio', { name: /Offline worker/ }).getAttribute('aria-disabled'),
	).toBe('true');
	expect(
		screen.getByRole('menuitemradio', { name: /Unsupported worker/ }).getAttribute('aria-disabled'),
	).toBe('true');
	await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Worker' }));
	expect(onSelect).toHaveBeenCalledWith(remote.id);
});
