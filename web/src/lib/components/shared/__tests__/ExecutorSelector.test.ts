import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import {
	localExecutor,
	remoteExecutor,
} from '$lib/executors/__tests__/fixtures.js';
import ExecutorSelector from '../ExecutorSelector.svelte';

afterEach(cleanup);

it('selects file-capable executors and keeps unavailable executors visible but disabled', async () => {
	const remote = {
		...remoteExecutor,
		machineServices: { files: true, git: false, gh: false, terminals: false },
	};
	const offline = {
		...remote,
		id: '33333333-3333-4333-8333-333333333333',
		label: 'Offline worker',
		availability: 'offline' as const,
	};
	const unsupported = {
		...remoteExecutor,
		id: '44444444-4444-4444-8444-444444444444',
		label: 'Unsupported worker',
	};
	const snapshot = [localExecutor, remote, offline, unsupported];
	const read = vi.fn(async () => snapshot);
	const executors = new ExecutorsStore(read);
	executors.applySnapshot(snapshot);
	const onSelect = vi.fn();
	render(ExecutorSelector, { executors, executorId: 'local', service: 'files', onSelect });
	await fireEvent.click(screen.getByRole('button', { name: 'Executor: Local' }));
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
	await fireEvent.click(screen.getByRole('button', { name: 'Executor: Local' }));
	await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Local' }));
	expect(onSelect).toHaveBeenLastCalledWith('local');
});

it.each(['files', 'git', 'agents'] as const)(
	'hides the %s selector for a Local-only inventory',
	(service) => {
		const executors = new ExecutorsStore();
		executors.applySnapshot([localExecutor]);
		render(ExecutorSelector, { executors, executorId: 'local', service, onSelect: vi.fn() });
		expect(screen.queryByRole('button', { name: /Executor:/ })).toBeNull();
	},
);

it.each(['files', 'git', 'agents'] as const)(
	'shows the themed executor icon with an offline remote (%s)',
	(service) => {
		const executors = new ExecutorsStore();
		executors.applySnapshot([localExecutor, { ...remoteExecutor, availability: 'offline' }]);
		render(ExecutorSelector, { executors, executorId: 'local', service, onSelect: vi.fn() });
		const trigger = screen.getByRole('button', { name: 'Executor: Local' });
		expect(trigger.querySelector('svg.lucide-network.text-file-icon-folder')).not.toBeNull();
	},
);

it('selects Git-capable executors independently of Files capability', async () => {
	const remote = {
		...remoteExecutor,
		machineServices: { files: false, git: true, gh: false, terminals: false },
	};
	const snapshot = [localExecutor, remote];
	const executors = new ExecutorsStore(async () => snapshot);
	executors.applySnapshot(snapshot);
	const onSelect = vi.fn();
	render(ExecutorSelector, { executors, executorId: 'local', service: 'git', onSelect });
	await fireEvent.click(screen.getByRole('button', { name: 'Executor: Local' }));
	await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Worker' }));
	expect(onSelect).toHaveBeenCalledWith(remote.id);
});

it('selects execution hosts without requiring Files or Git and retains missing selections', async () => {
	const snapshot = [localExecutor, remoteExecutor];
	const executors = new ExecutorsStore(async () => snapshot);
	executors.applySnapshot(snapshot);
	const onSelect = vi.fn();
	render(ExecutorSelector, { executors, executorId: 'missing', service: 'agents', presentation: 'composer', onSelect });
	const trigger = screen.getByRole('button', { name: /Executor:/ });
	expect(trigger.classList.contains('composer-executor-trigger')).toBe(true);
	await fireEvent.click(trigger);
	expect(screen.getByRole('menuitemradio', { name: /Unavailable/ }).getAttribute('aria-disabled')).toBe('true');
	await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Worker' }));
	expect(onSelect).toHaveBeenCalledWith(remoteExecutor.id);
});

it('updates the selected label and open menu availability when inventory changes', async () => {
	const remote = {
		...remoteExecutor,
		machineServices: { ...remoteExecutor.machineServices, git: true },
	};
	const snapshot = [localExecutor, remote];
	const executors = new ExecutorsStore(async () => snapshot);
	executors.applySnapshot(snapshot);
	render(ExecutorSelector, {
		executors,
		executorId: remote.id,
		service: 'git',
		onSelect: vi.fn(),
	});
	const picker = screen.getByRole('button', { name: 'Executor: Worker' });
	await fireEvent.click(picker);
	const renamed = { ...remote, label: 'Renamed worker' };
	executors.applySnapshot([localExecutor, { ...renamed, availability: 'offline' }]);
	await waitFor(() => {
		expect(picker.getAttribute('aria-label')).toBe('Executor: Renamed worker');
		expect(picker.getAttribute('title')).toBe('Renamed worker');
		expect(picker.textContent?.trim()).toBe('Renamed worker');
		expect(
			screen.getByRole('menuitemradio', { name: /Renamed worker/ }).getAttribute('aria-disabled'),
		).toBe('true');
	});
	executors.applySnapshot([localExecutor, renamed]);
	await waitFor(() =>
		expect(
			screen.getByRole('menuitemradio', { name: 'Renamed worker' }).getAttribute('aria-disabled'),
		).not.toBe('true'),
	);
});
