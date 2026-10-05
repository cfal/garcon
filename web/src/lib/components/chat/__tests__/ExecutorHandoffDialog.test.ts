import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import * as gitApi from '$lib/api/git';
import type { GitWorktreeItem } from '$lib/api/git';
import * as settingsApi from '$lib/api/settings.js';
import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { ExecutorHandoffProjectState } from '$lib/chat/conversation/executor-handoff-project.svelte.js';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';

vi.mock('$lib/api/chats', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/chats')>()),
	validateStart: vi.fn(),
}));
vi.mock('$lib/api/git', () => ({ getGitWorktrees: vi.fn(), gitCreateWorktree: vi.fn() }));
vi.mock('$lib/api/settings.js', () => ({ getRemoteSettings: vi.fn(), updateRemoteSettings: vi.fn() }));
vi.mock(
	'$lib/components/model-selector/ComposerModelSelector.svelte',
	async () => import('../../settings/__tests__/ComposerModelSelectorTestStub.svelte'),
);

const ExecutorHandoffDialogTestHost = (await import('./ExecutorHandoffDialogTestHost.svelte'))
	.default;

const machineServices = { files: true, git: true, gh: false, terminals: false, directoryCreation: true };
const worker = { ...remoteExecutor, machineServices };
const builder = {
	...remoteExecutor,
	id: '33333333-3333-4333-8333-333333333333',
	label: 'Builder',
	instanceId: 'synthetic-builder-instance',
	projectBasePath: '/builder',
	machineServices,
};
const executors = [localExecutor, worker, builder];
const selection = {
	agentId: 'claude',
	model: 'opus',
	apiProviderId: null,
	modelEndpointId: null,
	modelProtocol: null,
};

function settingsWithPins(): RemoteSettingsStore {
	const store = new RemoteSettingsStore();
	store.applySnapshot(
		makeRemoteSettingsSnapshot({
			paths: {
				pinnedProjectPaths: ['/local/pinned'],
				byExecutor: {
					[worker.id]: { recentPaths: [], pinnedPaths: ['/worker/pinned'] },
					[builder.id]: { recentPaths: [], pinnedPaths: ['/builder/pinned'] },
				},
			},
		}),
	);
	return store;
}

function makeWorktree(path: string, branch: string): GitWorktreeItem {
	return {
		name: branch,
		path,
		branch,
		isCurrent: false,
		isMain: branch === 'main',
		isPathMissing: false,
		lastModifiedAt: null,
	};
}

function pathInput(): HTMLInputElement {
	return screen.getByRole<HTMLInputElement>('textbox', { name: 'Destination project folder' });
}

function confirmButton(): HTMLButtonElement {
	return screen.getByRole<HTMLButtonElement>('button', { name: 'Use This Executor' });
}

describe('ExecutorHandoffDialog', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(ModelCatalogStore.prototype, 'refreshIfStale').mockResolvedValue();
	});

	afterEach(async () => {
		await vi.runAllTimersAsync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.mocked(chatsApi.validateStart).mockReset();
		vi.mocked(gitApi.getGitWorktrees).mockReset();
		vi.mocked(settingsApi.updateRemoteSettings).mockReset();
	});

	it('offers only the destination pins and confirms a pinned folder on that executor', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });
		const handoff = new ExecutorHandoffProjectState(() => true);
		const destination = handoff.ask('chat-1', worker.id, '/workspace/project', selection);
		const rendered = render(ExecutorHandoffDialogTestHost, {
			handoff,
			executors,
			remoteSettings: settingsWithPins(),
		});
		try {
			expect(await screen.findByRole('heading', { name: 'Move to Worker' })).toBeTruthy();
			expect(pathInput().value).toBe('/workspace/project');
			expect(screen.queryByRole('button', { name: '/local/pinned' })).toBeNull();
			expect(screen.queryByRole('button', { name: '/builder/pinned' })).toBeNull();

			await fireEvent.click(screen.getByRole('button', { name: '/worker/pinned' }));
			expect(pathInput().value).toBe('/worker/pinned');
			await vi.advanceTimersByTimeAsync(250);
			expect(chatsApi.validateStart).toHaveBeenLastCalledWith('/worker/pinned', {
				executorId: worker.id,
				signal: expect.any(AbortSignal),
			});
			await waitFor(() => expect(confirmButton().disabled).toBe(false));
			await fireEvent.click(confirmButton());

			await expect(destination).resolves.toEqual({ projectPath: '/worker/pinned', selection });
			expect(chatsApi.validateStart).toHaveBeenLastCalledWith('/worker/pinned', {
				executorId: worker.id,
			});
		} finally {
			rendered.unmount();
		}
	});

	it('keeps confirmation disabled until the destination folder validates', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({
			valid: false,
			errorCode: 'path_not_found',
		});
		const handoff = new ExecutorHandoffProjectState(() => true);
		void handoff.ask('chat-1', worker.id, '/workspace/missing', selection);
		const rendered = render(ExecutorHandoffDialogTestHost, {
			handoff,
			executors,
			remoteSettings: settingsWithPins(),
		});
		try {
			await vi.advanceTimersByTimeAsync(250);
			expect(await screen.findByText('Path does not exist.')).toBeTruthy();
			expect(pathInput().getAttribute('aria-invalid')).toBe('true');
			expect(confirmButton().disabled).toBe(true);
			expect(screen.queryByRole('button', { name: 'Select a different worktree' })).toBeNull();
		} finally {
			handoff.cancel();
			rendered.unmount();
		}
	});

	it('lists worktrees on the destination and replaces its pins when the destination changes', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		vi.mocked(gitApi.getGitWorktrees).mockResolvedValue({
			worktrees: [
				makeWorktree('/workspace/project', 'main'),
				makeWorktree('/workspace/project-feature', 'feature'),
			],
		});
		const handoff = new ExecutorHandoffProjectState(() => true);
		void handoff.ask('chat-1', worker.id, '/workspace/project', selection);
		const rendered = render(ExecutorHandoffDialogTestHost, {
			handoff,
			executors,
			remoteSettings: settingsWithPins(),
		});
		try {
			await vi.advanceTimersByTimeAsync(250);
			await fireEvent.click(
				await screen.findByRole('button', { name: 'Select a different worktree' }),
			);
			await screen.findByRole('dialog', { name: 'Select worktree' });
			expect(gitApi.getGitWorktrees).toHaveBeenCalledWith(
				{ executorId: worker.id, projectPath: '/workspace/project' },
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			await fireEvent.click(await screen.findByRole('option', { name: /feature/ }));
			expect(pathInput().value).toBe('/workspace/project-feature');

			void handoff.ask('chat-1', builder.id, '/workspace/project', selection);
			expect(await screen.findByRole('heading', { name: 'Move to Builder' })).toBeTruthy();
			expect(await screen.findByRole('button', { name: '/builder/pinned' })).toBeTruthy();
			expect(screen.queryByRole('button', { name: '/worker/pinned' })).toBeNull();
			expect(pathInput().value).toBe('/workspace/project');
			await vi.advanceTimersByTimeAsync(250);
			expect(chatsApi.validateStart).toHaveBeenLastCalledWith('/workspace/project', {
				executorId: builder.id,
				signal: expect.any(AbortSignal),
			});
		} finally {
			handoff.cancel();
			rendered.unmount();
		}
	});

	it('pins the chosen folder on the destination executor', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });
		const remoteSettings = settingsWithPins();
		const saved = Promise.withResolvers<Awaited<ReturnType<typeof settingsApi.updateRemoteSettings>>>();
		vi.mocked(settingsApi.updateRemoteSettings).mockReturnValue(saved.promise);
		const handoff = new ExecutorHandoffProjectState(() => true);
		void handoff.ask('chat-1', worker.id, '/workspace/project', selection);
		const rendered = render(ExecutorHandoffDialogTestHost, { handoff, executors, remoteSettings });
		try {
			await fireEvent.click(await screen.findByRole('button', { name: 'Pin project path' }));
			expect(settingsApi.updateRemoteSettings).toHaveBeenCalledWith({
				paths: {
					byExecutor: { [worker.id]: { pinnedPaths: ['/worker/pinned', '/workspace/project'] } },
				},
			});
			expect(await screen.findByRole('button', { name: '/workspace/project' })).toBeTruthy();
			expect(remoteSettings.snapshot?.paths.pinnedProjectPaths).toEqual(['/local/pinned']);
			saved.resolve({ success: true, settings: remoteSettings.snapshot! });
		} finally {
			handoff.cancel();
			rendered.unmount();
		}
	});

	it('does not offer browsing or worktrees where the destination lacks Files and Git', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		const handoff = new ExecutorHandoffProjectState(() => true);
		void handoff.ask('chat-1', remoteExecutor.id, '/worker/project', selection);
		const rendered = render(ExecutorHandoffDialogTestHost, {
			handoff,
			executors: [localExecutor, remoteExecutor],
			remoteSettings: settingsWithPins(),
		});
		try {
			await vi.advanceTimersByTimeAsync(250);
			await waitFor(() => expect(confirmButton().disabled).toBe(false));
			expect(
				screen.getByRole<HTMLButtonElement>('button', { name: 'Browse destination folder' }).disabled,
			).toBe(true);
			expect(screen.queryByRole('button', { name: 'Select a different worktree' })).toBeNull();
		} finally {
			handoff.cancel();
			rendered.unmount();
		}
	});
});
