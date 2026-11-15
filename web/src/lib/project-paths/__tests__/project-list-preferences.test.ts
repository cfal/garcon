import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import { removeProjectPathFromListOptimistically } from '../project-list-preferences';

vi.mock('$lib/api/settings.js', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
	removeProjectPathFromList: vi.fn(),
}));

const settingsApi = vi.mocked(await import('$lib/api/settings.js'));
const executorId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function fixture() {
	const snapshot = makeRemoteSettingsSnapshot({
		paths: {
			pinnedProjectPaths: ['D:\\projects\\atlas', '/local/keep'],
			recentProjectPaths: ['D:/projects/atlas', 'D:\\projects\\atlas', '/local/recent'],
			browseStartPath: '/local/default',
			byExecutor: {
				[executorId]: { defaultPath: '/remote/default', pinnedPaths: ['/project', '/remote/keep'], recentPaths: ['/project', '/remote/recent'] },
				[otherId]: { defaultPath: '/other/default', pinnedPaths: ['/project'], recentPaths: ['/project'] },
			},
		},
	});
	const store = new RemoteSettingsStore();
	store.applySnapshot(snapshot);
	return { store, snapshot };
}

describe('project list preferences', () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it('optimistically removes Local aliases and uses canonical responses across repeat identity requests', async () => {
		const { store, snapshot } = fixture();
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.removeProjectPathFromList>>>();
		settingsApi.removeProjectPathFromList.mockReturnValueOnce(pending.promise);
		const updating = removeProjectPathFromListOptimistically(store, 'D:/projects/atlas', { executorId: 'local' });
		await Promise.resolve();
		const paths = { ...snapshot.paths, pinnedProjectPaths: ['/local/keep'], recentProjectPaths: ['/local/recent'] };
		expect(store.snapshot?.paths).toEqual(paths);
		expect(settingsApi.removeProjectPathFromList).toHaveBeenCalledExactlyOnceWith({ executorId: 'local', projectPath: 'D:/projects/atlas' });
		const persisted = makeRemoteSettingsSnapshot({ version: 2, paths });
		pending.resolve({ success: true, settings: persisted });
		expect(await updating).toEqual(persisted);
		settingsApi.removeProjectPathFromList.mockResolvedValueOnce({ success: true, settings: persisted });
		expect(await removeProjectPathFromListOptimistically(store, 'D:\\projects\\atlas', { executorId: 'local' })).toEqual(persisted);
		expect(settingsApi.removeProjectPathFromList).toHaveBeenCalledTimes(2);
		expect(settingsApi.updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('removes only the captured remote owner and leaves defaults, Local and other owners intact', async () => {
		const { store, snapshot } = fixture();
		const paths = { ...snapshot.paths, byExecutor: { ...snapshot.paths.byExecutor, [executorId]: {
			defaultPath: '/remote/default', pinnedPaths: ['/remote/keep'], recentPaths: ['/remote/recent'],
		} } };
		const persisted = makeRemoteSettingsSnapshot({ version: 2, paths });
		settingsApi.removeProjectPathFromList.mockResolvedValueOnce({ success: true, settings: persisted });
		await removeProjectPathFromListOptimistically(store, '/project', { executorId });
		expect(settingsApi.removeProjectPathFromList).toHaveBeenCalledExactlyOnceWith({ executorId, projectPath: '/project' });
		expect(store.snapshot?.paths).toEqual(paths);
	});

	it('matches literal POSIX backslashes and whitespace exactly', async () => {
		const { store, snapshot } = fixture();
		const remaining = ['/projects/a/b', '/projects/a\\b '];
		store.applySnapshot({ ...snapshot, paths: {
			...snapshot.paths, pinnedProjectPaths: ['/projects/a\\b', ...remaining], recentProjectPaths: [...remaining, '/projects/a\\b'],
		} });
		settingsApi.removeProjectPathFromList.mockImplementationOnce(async () => ({ success: true, settings: {
			...snapshot, version: 2, paths: { ...snapshot.paths, pinnedProjectPaths: remaining, recentProjectPaths: remaining },
		} }));
		await removeProjectPathFromListOptimistically(store, '/projects/a\\b', { executorId: 'local' });
		expect(settingsApi.removeProjectPathFromList).toHaveBeenCalledExactlyOnceWith({ executorId: 'local', projectPath: '/projects/a\\b' });
		expect(store.snapshot?.paths.pinnedProjectPaths).toEqual(remaining);
		expect(store.snapshot?.paths.recentProjectPaths).toEqual(remaining);
	});

	it('removes remote Windows aliases without changing the matching Local shortcut', async () => {
		const { store, snapshot } = fixture();
		const owner = { defaultPath: 'D:/projects/atlas', pinnedPaths: ['D:\\projects\\atlas', '/remote/keep'], recentPaths: ['D:/projects/atlas', 'D:\\projects\\atlas'] };
		store.applySnapshot({ ...snapshot, paths: { ...snapshot.paths, byExecutor: {
			...snapshot.paths.byExecutor, [executorId]: owner,
		} } });
		const paths = { ...snapshot.paths, byExecutor: { ...snapshot.paths.byExecutor, [executorId]: {
			...owner, pinnedPaths: ['/remote/keep'], recentPaths: [],
		} } };
		settingsApi.removeProjectPathFromList.mockResolvedValueOnce({ success: true, settings: makeRemoteSettingsSnapshot({ version: 2, paths }) });
		await removeProjectPathFromListOptimistically(store, 'D:/projects/atlas', { executorId });
		expect(store.snapshot?.paths).toEqual(paths);
		expect(settingsApi.removeProjectPathFromList).toHaveBeenCalledExactlyOnceWith({ executorId, projectPath: 'D:/projects/atlas' });
	});

	it('restores optimistic removal after a failed save', async () => {
		const { store, snapshot } = fixture();
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.removeProjectPathFromList>>>();
		settingsApi.removeProjectPathFromList.mockReturnValueOnce(pending.promise);
		const updating = removeProjectPathFromListOptimistically(store, '/project', { executorId });
		await Promise.resolve();
		expect(store.snapshot?.paths.byExecutor?.[executorId]?.recentPaths).toEqual(['/remote/recent']);
		pending.reject(new Error('Synthetic write failure'));
		await expect(updating).rejects.toThrow('Synthetic write failure');
		expect(store.snapshot).toEqual(snapshot);
	});

	it('keeps a newer unrelated snapshot when an older removal fails', async () => {
		const { store, snapshot } = fixture();
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.removeProjectPathFromList>>>();
		settingsApi.removeProjectPathFromList.mockReturnValueOnce(pending.promise);
		const updating = removeProjectPathFromListOptimistically(store, '/project', { executorId });
		await Promise.resolve();
		const fresh = { ...snapshot, version: 2, ui: { pinnedInsertPosition: 'bottom' as const }, paths: {
			...snapshot.paths, recentProjectPaths: ['/local/new'],
		} };
		store.applySnapshot(fresh);
		pending.reject(new Error('Synthetic stale failure'));
		await expect(updating).rejects.toThrow('Synthetic stale failure');
		expect(store.snapshot).toEqual(fresh);
	});

	it('captures its explicit owner before settings hydration completes', async () => {
		const { snapshot } = fixture();
		const store = new RemoteSettingsStore();
		const loading = deferred<typeof snapshot>();
		settingsApi.getRemoteSettings.mockReturnValueOnce(loading.promise);
		const persisted = makeRemoteSettingsSnapshot({ version: 2, paths: { ...snapshot.paths, byExecutor: {
			...snapshot.paths.byExecutor, [executorId]: { defaultPath: '/remote/default', pinnedPaths: ['/remote/keep'], recentPaths: ['/remote/recent'] },
		} } });
		settingsApi.removeProjectPathFromList.mockResolvedValueOnce({ success: true, settings: persisted });
		const options = { executorId };
		const updating = removeProjectPathFromListOptimistically(store, '/project', options);
		options.executorId = 'local';
		loading.resolve(snapshot);
		await updating;
		expect(settingsApi.removeProjectPathFromList).toHaveBeenCalledExactlyOnceWith({ executorId, projectPath: '/project' });
	});

	it('sends identity even when the cache omits the path and retains newer server pins and recents', async () => {
		const { store, snapshot } = fixture();
		const persisted = makeRemoteSettingsSnapshot({ version: 2, paths: {
			...snapshot.paths, pinnedProjectPaths: ['/local/new-pin'], recentProjectPaths: ['/local/new-recent'],
		} });
		settingsApi.removeProjectPathFromList.mockResolvedValueOnce({ success: true, settings: persisted });
		await removeProjectPathFromListOptimistically(store, '/uncached/project', { executorId: 'local' });
		expect(settingsApi.removeProjectPathFromList).toHaveBeenCalledExactlyOnceWith({ executorId: 'local', projectPath: '/uncached/project' });
		expect(settingsApi.updateRemoteSettings).not.toHaveBeenCalled();
		expect(store.snapshot).toEqual(persisted);
	});
});
