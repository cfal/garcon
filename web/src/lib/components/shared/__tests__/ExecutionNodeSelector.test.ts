import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import {
	localExecutionNode,
	remoteExecutionNode,
} from '$lib/execution-nodes/__tests__/fixtures.js';
import ExecutionNodeSelector from '../ExecutionNodeSelector.svelte';

afterEach(cleanup);

it('selects file-capable nodes and keeps unavailable nodes visible but disabled', async () => {
	const remote = {
		...remoteExecutionNode,
		machineServices: { files: true, git: false, gh: false, terminals: false },
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
	render(ExecutionNodeSelector, { nodes, nodeId: 'local', service: 'files', onSelect });
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
	await fireEvent.click(screen.getByRole('button', { name: 'Execution node: Local' }));
	await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Local' }));
	expect(onSelect).toHaveBeenLastCalledWith('local');
});

it.each(['files', 'git'] as const)(
	'hides the %s selector for a Local-only inventory',
	(service) => {
		const nodes = new ExecutionNodesStore();
		nodes.applySnapshot([localExecutionNode]);
		render(ExecutionNodeSelector, { nodes, nodeId: 'local', service, onSelect: vi.fn() });
		expect(screen.queryByRole('button', { name: /Execution node:/ })).toBeNull();
	},
);

it.each(['files', 'git'] as const)(
	'shows the themed execution-node icon with an offline remote (%s)',
	(service) => {
		const nodes = new ExecutionNodesStore();
		nodes.applySnapshot([localExecutionNode, { ...remoteExecutionNode, availability: 'offline' }]);
		render(ExecutionNodeSelector, { nodes, nodeId: 'local', service, onSelect: vi.fn() });
		const trigger = screen.getByRole('button', { name: 'Execution node: Local' });
		expect(trigger.querySelector('svg.lucide-network.text-file-icon-folder')).not.toBeNull();
	},
);

it('selects Git-capable nodes independently of Files capability', async () => {
	const remote = {
		...remoteExecutionNode,
		machineServices: { files: false, git: true, gh: false, terminals: false },
	};
	const snapshot = [localExecutionNode, remote];
	const nodes = new ExecutionNodesStore(async () => snapshot);
	nodes.applySnapshot(snapshot);
	const onSelect = vi.fn();
	render(ExecutionNodeSelector, { nodes, nodeId: 'local', service: 'git', onSelect });
	await fireEvent.click(screen.getByRole('button', { name: 'Execution node: Local' }));
	await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Worker' }));
	expect(onSelect).toHaveBeenCalledWith(remote.id);
});
