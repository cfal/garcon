import { describe, expect, it, vi } from 'vitest';
import { NewChatProjectsController } from '../new-chat-projects-controller';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

function fixture() {
	const form = {
		executorId: 'local',
		projectPath: 'D:/projects/atlas',
		pinnedProjectPaths: ['D:\\projects\\atlas'],
		isUpdatingPinnedPath: false,
		showBrowser: true,
		selectExecutor: vi.fn((id: string) => {
			form.executorId = id;
			form.pinnedProjectPaths = [];
		}),
		selectProjectPath: vi.fn((path: string) => {
			form.projectPath = path;
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
		expect(projects.select(remoteExecutor.id, '/projects/recent')).toBe(false);
	});

	it('preserves literal backslashes in POSIX filenames and exact whitespace', () => {
		const { projects, settings, form } = fixture();
		form.pinnedProjectPaths = [];
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
});
