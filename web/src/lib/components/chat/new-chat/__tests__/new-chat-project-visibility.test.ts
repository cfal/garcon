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
		], { executorId: 'worker', path: '/chosen' });
		expect(result.visible).toEqual([
			{ executorId: 'worker', path: '/chosen' },
			...['/a', '/b', '/c', '/d'].map(path => ({ executorId: 'local', path })),
		]);
		expect(result.overflow).toEqual([
			{ executorId: 'local', path: '/e' },
			{ executorId: 'worker', path: '/a' }, { executorId: 'worker', path: '/last' },
		]);
	});

	it('keeps card identity stable across Windows slash aliases and distinct across owners', () => {
		const local = { executorId: 'local', path: 'D:\\work\\project' };
		expect(newChatProjectKey(local)).toBe(newChatProjectKey({ ...local, path: 'D:/work/project' }));
		expect(newChatProjectKey(local)).not.toBe(newChatProjectKey({ ...local, executorId: 'worker' }));
	});
});
