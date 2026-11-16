import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import * as gitApi from '$lib/api/git';
import * as settingsApi from '$lib/api/settings';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import NewChatFormTestHost from './NewChatFormTestHost.svelte';

vi.mock('../../composer/composer-markdown-editor-loader.js', () => ({
	loadComposerMarkdownEditor: vi.fn(() => new Promise(() => {})),
}));
vi.mock('$lib/api/chats', () => ({ validateStart: vi.fn() }));
vi.mock('$lib/api/git', () => ({ getGitWorktrees: vi.fn(), gitCreateWorktree: vi.fn() }));
vi.mock('$lib/api/settings', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
	removeProjectPathFromList: vi.fn(),
}));
vi.mock('$lib/api/files', () => ({ browseDirectory: vi.fn(async () => []) }));
vi.mock('$lib/api/chat-preambles', () => ({
	preambleSelectionPreview: vi.fn(async (request: { projectPath: string }) => ({
		success: true,
		canonicalProjectPath: request.projectPath,
		orderedPreambleIds: [],
		projection: { catalogRevision: 0, eligiblePreambles: [], unavailable: [] },
	})),
}));

const targets = [
	{ executorId: 'local', projectPath: '/workspace/project' },
	{ executorId: remoteExecutor.id, projectPath: '/worker/project' },
] as const;

function worktree(path: string, branch = 'main'): gitApi.GitWorktreeItem {
	return {
		name: branch,
		path,
		branch,
		isCurrent: branch === 'main',
		isMain: branch === 'main',
		isPathMissing: false,
		lastModifiedAt: null,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

async function openWorktrees(executorId: string, projectPath: string) {
	const onStartChat = vi.fn();
	render(NewChatFormTestHost, { props: {
		seed: { project: { executorId, projectPath }, prefill: 'Retain the unsent prompt.' },
		executorSnapshots: [localExecutor, {
			...remoteExecutor,
			executorServices: { ...remoteExecutor.executorServices, files: true, git: true },
		}],
		onStartChat,
	} });
	const region = await screen.findByRole('region', { name: 'Worktrees' });
	await waitFor(() => expect(within(region).getByRole('radio', { name: /^main/ })).toBeTruthy());
	const trigger = within(region).getByRole('button', { name: 'New worktree' });
	trigger.focus();
	await fireEvent.click(trigger);
	const modal = await screen.findByRole('dialog', { name: 'Select worktree' });
	return { trigger, modal, onStartChat };
}

beforeEach(() => {
	vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
		matches: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
	})));
	HTMLElement.prototype.scrollIntoView = vi.fn();
	vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
	vi.mocked(settingsApi.getRemoteSettings).mockResolvedValue(makeRemoteSettingsSnapshot());
	vi.mocked(gitApi.getGitWorktrees).mockImplementation(async ({ projectPath }) => ({
		worktrees: [worktree(projectPath)],
	}));
});

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});

describe('New Chat worktree creation', () => {
	it.each(targets)('creates and selects a worktree on $executorId without submitting the draft', async ({ executorId, projectPath }) => {
		const createdPath = projectPath + '/.worktrees/feature-preview';
		vi.mocked(gitApi.getGitWorktrees).mockImplementation(async ({ projectPath: requestedPath }) => ({
			worktrees: [worktree(projectPath), ...(requestedPath === createdPath ? [worktree(createdPath, 'feature/preview')] : [])],
		}));
		vi.mocked(gitApi.gitCreateWorktree).mockResolvedValue({ success: true, worktreePath: createdPath });
		const { modal, onStartChat } = await openWorktrees(executorId, projectPath);
		await waitFor(() => expect(within(modal).getByRole('option', { name: /main/ })).toBeTruthy());
		await fireEvent.click(within(modal).getByRole('button', { name: 'New worktree' }));
		await fireEvent.input(within(modal).getByPlaceholderText('Branch name (e.g. fix/login-bug)'), {
			target: { value: 'feature/preview' },
		});
		await fireEvent.click(within(modal).getByRole('button', { name: 'Create' }));
		await waitFor(() => expect(gitApi.gitCreateWorktree).toHaveBeenCalledWith(
			{ executorId, projectPath }, createdPath, { branch: 'feature/preview', baseRef: undefined },
		));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Select worktree' })).toBeNull());
		await waitFor(() => expect((screen.getByRole('radio', { name: /^feature\/preview/ }) as HTMLInputElement).checked).toBe(true));
		expect(screen.getByRole('button', { name: executorId === 'local' ? projectPath : 'Worker: ' + projectPath }).getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByDisplayValue('Retain the unsent prompt.')).toBeTruthy();
		expect(onStartChat).not.toHaveBeenCalled();
		await waitFor(() => expect((screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({
			executorId,
			projectPath: createdPath,
			firstMessage: 'Retain the unsent prompt.',
		}), expect.any(String));
	});

	it.each(targets)('cancels a mid-load modal without restarting discovery on $executorId', async ({ executorId, projectPath }) => {
		const pending = deferred<Awaited<ReturnType<typeof gitApi.getGitWorktrees>>>();
		vi.mocked(gitApi.getGitWorktrees)
			.mockResolvedValueOnce({ worktrees: [worktree(projectPath)] })
			.mockReturnValueOnce(pending.promise);
		const { trigger, modal } = await openWorktrees(executorId, projectPath);
		expect(gitApi.getGitWorktrees).toHaveBeenCalledTimes(2);
		const signal = vi.mocked(gitApi.getGitWorktrees).mock.calls[1]?.[1]?.signal;
		await fireEvent.click(within(modal).getByRole('button', { name: 'Close' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Select worktree' })).toBeNull());
		expect(signal?.aborted).toBe(true);
		pending.resolve({ worktrees: [worktree(projectPath + '/stale', 'stale')] });
		await pending.promise;
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(screen.queryByRole('radio', { name: /^stale/ })).toBeNull();
		expect(gitApi.getGitWorktrees).toHaveBeenCalledTimes(2);
		expect(screen.getByDisplayValue('Retain the unsent prompt.')).toBeTruthy();
	});

	it('closes the create form before the modal and restores the inline action focus', async () => {
		const { trigger, modal } = await openWorktrees('local', '/workspace/project');
		await fireEvent.click(within(modal).getByRole('button', { name: 'New worktree' }));
		const branchInput = within(modal).getByPlaceholderText('Branch name (e.g. fix/login-bug)');
		await fireEvent.input(branchInput, { target: { value: 'feature/in-progress' } });
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByDisplayValue('feature/in-progress')).toBeNull();
		expect(screen.getByRole('dialog', { name: 'Select worktree' })).toBeTruthy();
		await waitFor(() => expect(document.activeElement).toBe(within(modal).getByRole('combobox', { name: 'Filter worktrees' })));
		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Select worktree' })).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(gitApi.gitCreateWorktree).not.toHaveBeenCalled();
	});
});
