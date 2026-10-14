import { expect, it } from 'vitest';
import { executorPinnedPathGroups } from '../executor-pinned-paths';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

it('preserves duplicate paths on separate machines and includes offline and removed hosts', () => {
	const groups = executorPinnedPathGroups({ pinnedProjectPaths: ['/same'], browseStartPath: '', recentProjectPaths: [], byExecutor: {
		[remoteExecutor.id]: { pinnedPaths: ['/same'], recentPaths: [] },
		removed: { pinnedPaths: ['/old'], recentPaths: [] },
	} }, [localExecutor, { ...remoteExecutor, availability: 'offline' }], 'local', ['/same']);
	expect(groups).toEqual([
		{ executorId: 'local', paths: ['/same'] },
		{ executorId: remoteExecutor.id, paths: ['/same'] },
		{ executorId: 'removed', paths: ['/old'] },
	]);
});

it('overlays optimistic pins on the selected machine and removes empty groups', () => {
	expect(executorPinnedPathGroups(undefined, [localExecutor, remoteExecutor], remoteExecutor.id, ['/b', '/a', '/a'])).toEqual([
		{ executorId: remoteExecutor.id, paths: ['/a', '/b'] },
	]);
});
