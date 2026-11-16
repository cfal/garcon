import { describe, expect, it } from 'vitest';
import { newChatProjectKey, splitNewChatProjects } from '../new-chat-project-visibility';

describe('New Chat project visibility', () => {
	it('limits the combined executor list without dropping duplicate paths owned by different executors', () => {
		const local = { executorId: 'local', paths: ['/same', '/local/b', '/local/c', '/local/d'] };
		const remote = { executorId: 'worker', paths: ['/same', '/worker/b', '/worker/c'] };
		const result = splitNewChatProjects([local, remote]);
		expect(result.visible).toEqual([
			...local.paths.map(path => ({ executorId: 'local', path })),
			{ executorId: 'worker', path: '/same' },
		]);
		expect(result.overflow).toEqual([
			{ executorId: 'worker', path: '/worker/b' }, { executorId: 'worker', path: '/worker/c' },
		]);
		expect(local.paths).toEqual(['/same', '/local/b', '/local/c', '/local/d']);
		expect(remote.paths).toEqual(['/same', '/worker/b', '/worker/c']);
	});

	it('keeps the full list visible at the five-project boundary', () => {
		const groups = [{ executorId: 'local', paths: ['/a', '/b', '/c', '/d', '/e'] }];
		expect(splitNewChatProjects(groups)).toEqual({
			visible: groups[0]!.paths.map(path => ({ executorId: 'local', path })), overflow: [],
		});
		expect(splitNewChatProjects([])).toEqual({ visible: [], overflow: [] });
	});

	it('promotes an overflow selection across executors while retaining every other project in its original order', () => {
		const result = splitNewChatProjects([
			{ executorId: 'local', paths: ['/a', '/b', '/c', '/d', '/e'] },
			{ executorId: 'worker', paths: ['/a', '/chosen', '/last'] },
		], { promoted: { executorId: 'worker', path: '/chosen' } });
		expect(result.visible).toEqual([
			{ executorId: 'worker', path: '/chosen' },
			...['/a', '/b', '/c', '/d'].map(path => ({ executorId: 'local', path })),
		]);
		expect(result.overflow).toEqual([
			{ executorId: 'local', path: '/e' },
			{ executorId: 'worker', path: '/a' }, { executorId: 'worker', path: '/last' },
		]);
	});

	it.each([
		{ source: 'seeded', executorId: 'local', path: '/seeded' },
		{ source: 'browsed', executorId: 'local', path: '/browsed' },
		{ source: 'cross-executor', executorId: 'worker', path: '/a' },
	])('keeps a $source selection in the primary list when saved projects fill it', ({ executorId, path }) => {
		const localPaths = ['/a', '/b', '/c', '/d', '/e'];
		const groups = [
			{ executorId: 'local', paths: executorId === 'local' ? [...localPaths, path] : localPaths },
			{ executorId: 'worker', paths: executorId === 'worker' ? [path, '/other'] : ['/other'] },
		];
		const result = splitNewChatProjects(groups, { selected: { executorId, path } });
		expect(result.visible).toEqual([
			{ executorId, path },
			...localPaths.slice(0, 4).map(localPath => ({ executorId: 'local', path: localPath })),
		]);
		expect(result.overflow[0]).toEqual({ executorId: 'local', path: '/e' });
		expect([...result.visible, ...result.overflow]).toHaveLength(groups.flatMap(group => group.paths).length);
	});

	it('preserves primary-card order when selection is already visible', () => {
		const groups = [{ executorId: 'local', paths: ['/a', '/b', '/c', '/d', '/e', '/f'] }];
		const baseline = splitNewChatProjects(groups);
		for (const path of ['/a', '/c', '/e']) {
			expect(splitNewChatProjects(groups, { selected: { executorId: 'local', path } })).toEqual(baseline);
		}
	});

	it('retains an explicit More promotion when a different primary project is selected', () => {
		const groups = [{ executorId: 'local', paths: ['/a', '/b', '/c', '/d', '/e', '/f', '/g'] }];
		const promoted = { executorId: 'local', path: '/g' };
		expect(splitNewChatProjects(groups, { promoted, selected: { executorId: 'local', path: '/b' } }))
			.toEqual(splitNewChatProjects(groups, { promoted }));
		expect(splitNewChatProjects(groups, { promoted, selected: { executorId: 'local', path: '/f' } }).visible)
			.toEqual(['/f', '/g', '/a', '/b', '/c'].map(path => ({ executorId: 'local', path })));
	});

	it('matches the selected Windows slash alias without adding a duplicate card', () => {
		const groups = [{ executorId: 'local', paths: ['/a', '/b', '/c', '/d', '/e', 'D:\\work\\selected'] }];
		const result = splitNewChatProjects(groups, {
			selected: { executorId: 'local', path: 'D:/work/selected' },
		});
		expect(result.visible[0]).toEqual({ executorId: 'local', path: 'D:\\work\\selected' });
		expect([...result.visible, ...result.overflow]).toHaveLength(6);
	});

	it('does not recreate removed or offline projects absent from the eligible groups', () => {
		const groups = [{ executorId: 'local', paths: ['/a', '/b', '/c', '/d', '/e', '/f'] }];
		for (const selected of [
			{ executorId: 'local', path: '/removed' },
			{ executorId: 'offline', path: '/a' },
		]) {
			expect(splitNewChatProjects(groups, { selected, promoted: selected })).toEqual(splitNewChatProjects(groups));
		}
	});

	it('keeps card identity stable across Windows slash aliases and distinct across owners', () => {
		const local = { executorId: 'local', path: 'D:\\work\\project' };
		expect(newChatProjectKey(local)).toBe(newChatProjectKey({ ...local, path: 'D:/work/project' }));
		expect(newChatProjectKey(local)).not.toBe(newChatProjectKey({ ...local, executorId: 'worker' }));
	});
});
