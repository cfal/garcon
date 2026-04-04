import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import NewChatFormTestHarness from './NewChatFormTestHarness.svelte';
import * as settingsApi from '$lib/api/settings';
import * as gitApi from '$lib/api/git';
import type { RemoteSettingsSnapshot } from '$shared/settings';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn()
}));

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn()
}));

vi.mock('$lib/api/settings', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeSnapshot(overrides: Partial<RemoteSettingsSnapshot> = {}): RemoteSettingsSnapshot {
	return {
		version: 1,
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '' },
		pinnedChatIds: [],
		lastProvider: 'claude',
		lastProjectPath: '',
		lastModel: 'opus',
		lastPermissionMode: 'default',
		lastThinkingMode: 'none',
		lastClaudeThinkingMode: 'auto',
		lastAmpAgentMode: 'smart',
		projectBasePath: '/workspace',
		telegramBotTokenAvailable: false,
		...overrides,
	};
}

describe('NewChatForm', () => {
	it('shows a centered spinner and hides the composer until settings load', async () => {
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.getRemoteSettings>>>();
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValueOnce(pending.promise);

		const { container } = render(NewChatFormTestHarness);

		const projectPathInput = screen.getByLabelText('Project Path');
		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		const hiddenFormContainer = container.querySelector('.space-y-6[aria-hidden="true"]');

		expect(screen.getByRole('status', { name: 'Loading chat defaults...' })).toBeTruthy();
		expect(hiddenFormContainer).toBeTruthy();
		expect(hiddenFormContainer?.contains(projectPathInput)).toBe(true);
		expect(hiddenFormContainer?.contains(messageInput)).toBe(true);

		pending.resolve(makeSnapshot({
			lastProjectPath: '/workspace/project',
		}));

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		expect(container.querySelector('.space-y-6[aria-hidden="true"]')).toBeNull();
		expect(container.querySelector('.space-y-6[aria-hidden="false"]')?.contains(projectPathInput)).toBe(true);
		expect(container.querySelector('.space-y-6[aria-hidden="false"]')?.contains(messageInput)).toBe(true);
	});

	it('opens the worktree picker as a separate dialog when the project is a git repo', async () => {
		const chatsApi = await import('$lib/api/chats');
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot({
			lastProjectPath: '/workspace/project',
		}));
		vi.mocked(chatsApi.validateStart).mockResolvedValue({
			valid: true,
			isGitRepo: true
		});
		vi.mocked(gitApi.getGitWorktrees).mockResolvedValue({
			worktrees: [
				{
					name: 'main',
					path: '/workspace/project',
					branch: 'main',
					isCurrent: true,
					isMain: true,
					isPathMissing: false
				}
			]
		});

		render(NewChatFormTestHarness);

		const openButton = await screen.findByRole('button', { name: 'Select a different worktree' });
		await fireEvent.click(openButton);

		const worktreeDialog = await screen.findByRole('dialog', { name: 'Select worktree' });
		expect(worktreeDialog).toBeTruthy();
		expect(worktreeDialog.textContent).toContain('New worktree');
	});

});
