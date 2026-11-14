import { describe, expect, it, vi } from 'vitest';
import { NewChatProjectsController } from '../new-chat-projects-controller';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

function fixture() {
	const form = {
		executorId: 'local',
		projectPath: 'D:/projects/atlas',
		selectedProjectPath: 'D:/projects/atlas',
		pinnedProjectPaths: ['D:\\projects\\atlas'],
		isUpdatingPinnedPath: false,
		showBrowser: true,
		error: null as string | null,
		selectExecutor: vi.fn((id: string) => {
			form.executorId = id;
			form.pinnedProjectPaths = [];
		}),
		selectProjectPath: vi.fn((path: string) => {
			form.projectPath = path;
			form.selectedProjectPath = path;
		}),
	};
	const settings = {
		snapshot: makeRemoteSettingsSnapshot({
			paths: {
				pinnedProjectPaths: ['D:\\projects\\atlas'],
				recentProjectPaths: ['D:/projects/atlas', '/projects/recent', '/projects/recent', '  '],
				byExecutor: {
					[remoteExecutor.id]: { pinnedPaths: [], recentPaths: ['/projects/recent'] },
					removed: { pinnedPaths: [], recentPaths: ['/projects/offline'] },
				},
			},
		}),
	};
	const executors = {
		executors: [localExecutor, remoteExecutor],
		isReady: vi.fn((id: string) => id !== 'removed'),
	};
	return {
		form,
		settings,
		executors,
		projects: new NewChatProjectsController(() => form, executors, settings),
	};
}

describe('new chat projects', () => {
	it('includes recent-only folders, preserves owners, and deduplicates Windows slash variants', () => {
		const { projects } = fixture();
		expect(projects.groups).toEqual([
			{ executorId: 'local', paths: ['D:\\projects\\atlas', '/projects/recent'] },
			{ executorId: remoteExecutor.id, paths: ['/projects/recent'] },
			{ executorId: 'removed', paths: ['/projects/offline'] },
		]);
		expect(projects.isPinned('local', 'D:/projects/atlas')).toBe(true);
		expect(projects.isSelected('local', 'D:\\projects\\atlas')).toBe(true);
		expect(projects.isSelected(remoteExecutor.id, 'D:/projects/atlas')).toBe(false);
	});

	it('selects a recent folder on its owner and rejects stale, offline or pending selections', () => {
		const { projects, form, settings } = fixture();
		expect(projects.select('removed', '/projects/offline')).toBe(false);
		form.isUpdatingPinnedPath = true;
		expect(projects.select(remoteExecutor.id, '/projects/recent')).toBe(false);
		form.isUpdatingPinnedPath = false;
		expect(projects.select(remoteExecutor.id, '/projects/recent')).toBe(true);
		expect(form.executorId).toBe(remoteExecutor.id);
		expect(form.projectPath).toBe('/projects/recent');
		expect(form.showBrowser).toBe(false);
		settings.snapshot = makeRemoteSettingsSnapshot();
		expect(projects.select(remoteExecutor.id, '/projects/stale')).toBe(false);
		expect(projects.groups).toEqual([{ executorId: remoteExecutor.id, paths: ['/projects/recent'] }]);
	});

	it('preserves literal backslashes in POSIX filenames and exact whitespace', () => {
		const { projects, settings, form } = fixture();
		form.pinnedProjectPaths = [];
		form.selectedProjectPath = '';
		settings.snapshot = makeRemoteSettingsSnapshot({
			paths: {
				recentProjectPaths: ['/projects/a\\b', '/projects/a/b', '/projects/spaces '],
			},
		});
		expect(projects.groups[0]?.paths).toEqual([
			'/projects/a\\b',
			'/projects/a/b',
			'/projects/spaces ',
		]);
	});

	it('pins a different executor card without changing the selected project', async () => {
		const { projects, form, settings } = fixture();
		const updated = makeRemoteSettingsSnapshot({
			paths: {
				...settings.snapshot.paths,
				byExecutor: {
					...settings.snapshot.paths.byExecutor,
					[remoteExecutor.id]: {
						pinnedPaths: ['/projects/recent'],
						recentPaths: ['/projects/recent'],
					},
				},
			},
		});
		const persist = vi.fn().mockResolvedValue(updated);
		expect(await projects.togglePin(remoteExecutor.id, '/projects/recent', persist)).toBe(true);
		expect(persist).toHaveBeenCalledExactlyOnceWith(['/projects/recent'], remoteExecutor.id);
		expect(form.executorId).toBe('local');
		expect(form.projectPath).toBe('D:/projects/atlas');
		expect(form.pinnedProjectPaths).toEqual(['D:\\projects\\atlas']);
		expect(form.selectExecutor).not.toHaveBeenCalled();
		expect(form.selectProjectPath).not.toHaveBeenCalled();
		expect(form.showBrowser).toBe(true);
	});

	it('keeps a newly browsed project pinnable while its selected worktree remains distinct', async () => {
		const { projects, form, settings } = fixture();
		form.selectedProjectPath = '/projects/new';
		form.projectPath = '/projects/new-worktree';
		expect(projects.groups[0]?.paths).toEqual([
			'D:\\projects\\atlas',
			'/projects/recent',
			'/projects/new',
		]);
		expect(projects.isSelected('local', '/projects/new')).toBe(true);
		expect(projects.isSelected('local', '/projects/new-worktree')).toBe(false);
		const updated = makeRemoteSettingsSnapshot({
			paths: {
				...settings.snapshot.paths,
				pinnedProjectPaths: ['/projects/new', 'D:\\projects\\atlas'],
			},
		});
		const persist = vi.fn().mockResolvedValue(updated);
		expect(await projects.togglePin('local', '/projects/new', persist)).toBe(true);
		expect(form.projectPath).toBe('/projects/new-worktree');
		expect(form.selectedProjectPath).toBe('/projects/new');
		expect(persist).toHaveBeenCalledExactlyOnceWith(
			['/projects/new', 'D:\\projects\\atlas'],
			'local',
		);
	});

	it('unpins the canonical saved Windows spelling and restores it on failure', async () => {
		const { projects, form } = fixture();
		form.pinnedProjectPaths.push('D:/projects/atlas');
		let rejectSave!: (error: Error) => void;
		const pending = new Promise<ReturnType<typeof makeRemoteSettingsSnapshot>>(
			(_resolve, reject) => {
				rejectSave = reject;
			},
		);
		const persist = vi.fn(() => pending);
		const updating = projects.togglePin('local', 'D:/projects/atlas', persist);
		expect(form.isUpdatingPinnedPath).toBe(true);
		expect(form.pinnedProjectPaths).toEqual([]);
		expect(projects.isPinPending('local', 'D:/projects/atlas')).toBe(true);
		expect(projects.isPinPending(remoteExecutor.id, '/projects/recent')).toBe(false);
		expect(await projects.togglePin(remoteExecutor.id, '/projects/recent', persist)).toBe(false);
		expect(projects.select(remoteExecutor.id, '/projects/recent')).toBe(false);
		rejectSave(new Error('Synthetic settings failure'));
		expect(await updating).toBe(false);
		expect(form.error).toBe('Synthetic settings failure');
		expect(form.pinnedProjectPaths).toEqual(['D:\\projects\\atlas', 'D:/projects/atlas']);
		expect(form.isUpdatingPinnedPath).toBe(false);
		expect(projects.isPinPending('local', 'D:/projects/atlas')).toBe(false);
		expect(persist).toHaveBeenCalledExactlyOnceWith([], 'local');
	});

	it('rejects stale pin targets before persisting', async () => {
		const { projects } = fixture();
		const persist = vi.fn();
		expect(await projects.togglePin(remoteExecutor.id, '/projects/stale', persist)).toBe(false);
		expect(persist).not.toHaveBeenCalled();
	});

	it('allows pin preferences for unavailable owners without selecting them', async () => {
		const { projects, form, settings } = fixture();
		const persist = vi.fn().mockResolvedValue(settings.snapshot);
		expect(await projects.togglePin('removed', '/projects/offline', persist)).toBe(true);
		expect(persist).toHaveBeenCalledExactlyOnceWith(['/projects/offline'], 'removed');
		expect(form.executorId).toBe('local');
		expect(form.selectExecutor).not.toHaveBeenCalled();
	});
});
