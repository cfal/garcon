import { expect, it } from 'vitest';
import { executorPinnedPathGroups, filterExecutorPinnedPathGroups } from '../executor-pinned-paths';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

it('preserves duplicate paths on separate machines and includes offline and removed hosts', () => {
	const groups = executorPinnedPathGroups(
		{
			pinnedProjectPaths: ['/same'],
			browseStartPath: '',
			recentProjectPaths: [],
			byExecutor: {
				[remoteExecutor.id]: { pinnedPaths: ['/same'], recentPaths: [] },
				removed: { pinnedPaths: ['/old'], recentPaths: [] },
			},
		},
		[localExecutor, { ...remoteExecutor, availability: 'offline' }],
		'local',
		['/same'],
	);
	expect(groups).toEqual([
		{ executorId: 'local', paths: ['/same'] },
		{ executorId: remoteExecutor.id, paths: ['/same'] },
		{ executorId: 'removed', paths: ['/old'] },
	]);
});

it('overlays optimistic pins on the selected machine and removes empty groups', () => {
	expect(
		executorPinnedPathGroups(undefined, [localExecutor, remoteExecutor], remoteExecutor.id, [
			'/b',
			'/a',
			'/a',
		]),
	).toEqual([{ executorId: remoteExecutor.id, paths: ['/a', '/b'] }]);
});

it('filters paths and machine names without changing bookmark identity or the source groups', () => {
	const groups = [
		{ executorId: 'local', paths: ['/same', '/work/Space Project '] },
		{ executorId: remoteExecutor.id, paths: ['/same', '/other'] },
		{ executorId: 'removed', paths: ['/old'] },
	];
	expect(
		filterExecutorPinnedPathGroups(groups, [localExecutor, remoteExecutor], ' SPACE '),
	).toEqual([{ executorId: 'local', paths: ['/work/Space Project '] }]);
	expect(filterExecutorPinnedPathGroups(groups, [localExecutor, remoteExecutor], 'WORKER')).toEqual(
		[groups[1]],
	);
	expect(filterExecutorPinnedPathGroups(groups, [localExecutor, remoteExecutor], 'same')).toEqual([
		{ executorId: 'local', paths: ['/same'] },
		{ executorId: remoteExecutor.id, paths: ['/same'] },
	]);
	expect(filterExecutorPinnedPathGroups(groups, [], 'removed')).toEqual([groups[2]]);
	expect(filterExecutorPinnedPathGroups(groups, [], 'missing')).toEqual([]);
	expect(filterExecutorPinnedPathGroups(groups, [], ' ')).toEqual(groups);
	expect(groups[0].paths).toEqual(['/same', '/work/Space Project ']);
});
