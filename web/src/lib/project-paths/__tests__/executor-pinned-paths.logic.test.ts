import { describe, expect, it } from 'vitest';
import { executorPinnedPathGroups } from '../executor-pinned-paths';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

describe('executor pinned path groups', () => {
	it('preserves identical paths on distinct owners, exact whitespace and unavailable pins', () => {
		const groups = executorPinnedPathGroups(
			{
				pinnedProjectPaths: ['/same'],
				browseStartPath: '',
				recentProjectPaths: [],
				byExecutor: {
					[remoteExecutor.id]: { recentPaths: [], pinnedPaths: ['/same', '/space ', '/same'] },
					removed: { recentPaths: [], pinnedPaths: ['/retained'] },
				},
			},
			[localExecutor, remoteExecutor],
			'local',
			['/same'],
		);
		expect(groups).toEqual([
			{ executorId: 'local', paths: ['/same'] },
			{ executorId: remoteExecutor.id, paths: ['/same', '/space '] },
			{ executorId: 'removed', paths: ['/retained'] },
		]);
	});
	it('uses optimistic current pins and omits empty owners', () => {
		expect(
			executorPinnedPathGroups(undefined, [localExecutor, remoteExecutor], remoteExecutor.id, [
				'/pending',
			]),
		).toEqual([{ executorId: remoteExecutor.id, paths: ['/pending'] }]);
	});
});
