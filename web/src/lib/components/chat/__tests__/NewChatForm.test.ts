import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import NewChatFormTestHost from './NewChatFormTestHost.svelte';
import * as settingsApi from '$lib/api/settings';
import * as gitApi from '$lib/api/git';
import type { RemoteSettingsSnapshot } from '$shared/settings';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn(),
}));

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn(),
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

type SnapshotOverrides = Partial<Omit<RemoteSettingsSnapshot, 'paths' | 'executionDefaults'>> & {
	paths?: Partial<RemoteSettingsSnapshot['paths']>;
	executionDefaults?: {
		global?: Partial<RemoteSettingsSnapshot['executionDefaults']['global']>;
		byAgent?: RemoteSettingsSnapshot['executionDefaults']['byAgent'];
	};
};

function makeSnapshot(overrides: SnapshotOverrides = {}): RemoteSettingsSnapshot {
	const snapshot: RemoteSettingsSnapshot = {
		version: 1,
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [
			{
				agentId: 'claude',
				model: 'opus',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
		],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				claudeThinkingMode: 'auto',
				ampAgentMode: 'smart',
			},
			byAgent: {},
		},
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
	};
	return {
		...snapshot,
		...overrides,
		paths: {
			...snapshot.paths,
			...(overrides.paths ?? {}),
		},
		executionDefaults: {
			global: {
				...snapshot.executionDefaults.global,
				...(overrides.executionDefaults?.global ?? {}),
			},
			byAgent: {
				...snapshot.executionDefaults.byAgent,
				...(overrides.executionDefaults?.byAgent ?? {}),
			},
		},
	};
}

function waitForDialogTeardown(): Promise<void> {
	// Bits UI restores body scroll styles on a delayed timer after dialog close.
	return new Promise((resolve) => window.setTimeout(resolve, 30));
}

describe('NewChatForm', () => {
	it('shows a centered spinner and hides the composer until settings load', async () => {
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.getRemoteSettings>>>();
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValueOnce(pending.promise);

		const { container } = render(NewChatFormTestHost);

		const projectPathInput = screen.getByLabelText('Project Path');
		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		const hiddenFormContainer = container.querySelector('.space-y-6[aria-hidden="true"]');

		expect(screen.getByRole('status', { name: 'Loading chat defaults...' })).toBeTruthy();
		expect(hiddenFormContainer).toBeTruthy();
		expect(hiddenFormContainer?.contains(projectPathInput)).toBe(true);
		expect(hiddenFormContainer?.contains(messageInput)).toBe(true);

		pending.resolve(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
			}),
		);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		expect(container.querySelector('.space-y-6[aria-hidden="true"]')).toBeNull();
		expect(
			container.querySelector('.space-y-6[aria-hidden="false"]')?.contains(projectPathInput),
		).toBe(true);
		expect(container.querySelector('.space-y-6[aria-hidden="false"]')?.contains(messageInput)).toBe(
			true,
		);
	});

	it('opens the worktree picker as a separate dialog when the project is a git repo', async () => {
		const chatsApi = await import('$lib/api/chats');
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
			}),
		);
		vi.mocked(chatsApi.validateStart).mockResolvedValue({
			valid: true,
			isGitRepo: true,
		});
		vi.mocked(gitApi.getGitWorktrees).mockResolvedValue({
			worktrees: [
				{
					name: 'main',
					path: '/workspace/project',
					branch: 'main',
					isCurrent: true,
					isMain: true,
					isPathMissing: false,
				},
			],
		});

		render(NewChatFormTestHost);

		const openButton = await screen.findByRole('button', { name: 'Select a different worktree' });
		await fireEvent.click(openButton);

		const worktreeDialog = await screen.findByRole('dialog', { name: 'Select worktree' });
		expect(worktreeDialog).toBeTruthy();
		expect(worktreeDialog.textContent).toContain('New worktree');

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Select worktree' })).toBeNull();
		});
		await waitForDialogTeardown();
	});

	it('opens the model selector at recents when multiple recent targets exist', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'claude',
						model: 'opus',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
					{
						agentId: 'codex',
						model: 'gpt-5.4',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
			}),
		);

		render(NewChatFormTestHost);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Opus/ }));

		expect(await screen.findByText('Recent models')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Claude · Anthropic · Opus' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Codex · OpenAI · GPT-5.4' })).toBeTruthy();
		expect(screen.queryByRole('listbox', { name: 'Model' })).toBeNull();
	});

	it('opens the model selector at the selected model when only one recent target exists', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(makeSnapshot());

		render(NewChatFormTestHost);

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		await fireEvent.click(screen.getByRole('button', { name: /Claude .* Opus/ }));

		const listbox = await screen.findByRole('listbox', { name: 'Model' });
		expect(listbox).toBeTruthy();
		expect(screen.queryByText('Recent models')).toBeNull();
	});
});
