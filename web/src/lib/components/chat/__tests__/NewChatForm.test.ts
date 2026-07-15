import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewChatFormTestHost from './NewChatFormTestHost.svelte';
import * as settingsApi from '$lib/api/settings';
import * as gitApi from '$lib/api/git';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import * as snippetsApi from '$lib/api/snippets';

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

vi.mock('$lib/api/snippets', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/snippets')>();
	return { ...actual, expandSnippet: vi.fn() };
});

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

function stubMatchMedia(matches: boolean): void {
	vi.stubGlobal(
		'matchMedia',
		vi.fn().mockImplementation(() => ({
			matches,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		})),
	);
}

async function renderSubmittableForm(onStartChat: () => void): Promise<HTMLTextAreaElement> {
	const chatsApi = await import('$lib/api/chats');
	vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });
	vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
		makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
	);

	render(NewChatFormTestHost, { props: { onStartChat } });

	await waitFor(() => {
		expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
	});

	const messageInput = screen.getByPlaceholderText(
		'How can I help you today?',
	) as HTMLTextAreaElement;
	await fireEvent.input(messageInput, { target: { value: 'first line' } });

	// Wait for the seeded path to validate so the submit gate opens.
	await waitFor(() => {
		const submit = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
	});

	return messageInput;
}

describe('NewChatForm', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.mocked(snippetsApi.expandSnippet).mockReset();
	});

	it('does not submit on Enter on mobile (Enter inserts a newline)', async () => {
		stubMatchMedia(true);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);

		// fireEvent returns false when the handler called preventDefault. On mobile
		// Enter must fall through to the textarea so a newline is inserted.
		const notPrevented = await fireEvent.keyDown(messageInput, { key: 'Enter' });

		expect(onStartChat).not.toHaveBeenCalled();
		expect(notPrevented).toBe(true);
	});

	it('submits on Enter on desktop', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);

		await fireEvent.keyDown(messageInput, { key: 'Enter' });

		expect(onStartChat).toHaveBeenCalledTimes(1);
	});

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

	it('does not add bottom padding outside the shared composer bar', () => {
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.getRemoteSettings>>>();
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValueOnce(pending.promise);

		render(NewChatFormTestHost);

		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		expect(messageInput.parentElement?.className).not.toContain('pb-1.5');
	});

	it('shows a spinner while pinned project path persistence is pending', async () => {
		stubMatchMedia(false);
		const chatsApi = await import('$lib/api/chats');
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);
		const pending = deferred<Awaited<ReturnType<typeof settingsApi.updateRemoteSettings>>>();
		vi.mocked(settingsApi.updateRemoteSettings).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();

		render(NewChatFormTestHost, { props: { onStartChat } });

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const messageInput = screen.getByPlaceholderText(
			'How can I help you today?',
		) as HTMLTextAreaElement;
		await fireEvent.input(messageInput, { target: { value: 'start while pin saves' } });
		const startButton = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
		await waitFor(() => {
			expect(startButton.disabled).toBe(false);
		});

		const toggleButton = screen.getByRole('button', { name: 'Pin project path' });
		await fireEvent.click(toggleButton);

		const projectPathInput = screen.getByLabelText('Project Path') as HTMLInputElement;
		expect(toggleButton.getAttribute('aria-busy')).toBe('true');
		expect(toggleButton.querySelector('.animate-spin')).toBeTruthy();
		expect(projectPathInput.readOnly).toBe(true);
		expect(
			(screen.getByRole('button', { name: '/workspace/project' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(startButton.disabled).toBe(false);

		await fireEvent.click(startButton);
		expect(onStartChat).toHaveBeenCalledTimes(1);

		pending.resolve({
			success: true,
			settings: makeSnapshot({
				version: 2,
				paths: {
					recentProjectPaths: ['/workspace/project'],
					pinnedProjectPaths: ['/workspace/project'],
				},
			}),
		});
		await waitFor(() => {
			expect(toggleButton.getAttribute('aria-busy')).toBe('false');
		});
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
					lastModifiedAt: null,
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
		expect(screen.getByRole('button', { name: 'Claude · Claude OAuth · Opus' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Codex · OpenAI OAuth · GPT-5.4' })).toBeTruthy();
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

	it('expands /snippet for review before starting a new chat', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			shortName: 'review',
			expandedText: 'Review the API in /workspace/project',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review the API' } });

		await fireEvent.keyDown(messageInput, { key: 'Enter' });

		await waitFor(() => expect(messageInput.value).toBe('Review the API in /workspace/project'));
		expect(onStartChat).not.toHaveBeenCalled();
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: 'the API',
				context: { type: 'project', projectPath: '/workspace/project' },
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).toHaveBeenCalledTimes(1);
	});

	it('preserves the invocation and reports a failed expansion', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockRejectedValueOnce(new Error('server unavailable'));
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review keep this' } });

		await fireEvent.keyDown(messageInput, { key: 'Enter' });

		await screen.findByText('Snippet expansion failed: server unavailable');
		expect(messageInput.value).toBe('/snippet review keep this');
		expect(messageInput.readOnly).toBe(false);
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('rejects a menu expansion when the selected snippet identity changed', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'replacement-review',
			shortName: 'review',
			expandedText: 'must not apply',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		const snippetsItem = await screen.findByRole('menuitem', { name: /Snippets/ });
		await fireEvent.pointerMove(snippetsItem, { pointerType: 'mouse' });
		await fireEvent.click(await screen.findByRole('menuitem', { name: /\/snippet review/ }));

		await screen.findByText('That snippet changed. Select it again.');
		await waitFor(() => expect(screen.getByTestId('snippet-load-count').textContent).toBe('2'));
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('does not apply a pending expansion after the project path changes', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review old path' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });
		expect(messageInput.hasAttribute('data-local-escape-owner')).toBe(true);

		const pathInput = screen.getByRole('textbox', { name: 'Project Path' });
		await fireEvent.input(pathInput, { target: { value: '/workspace/other' } });
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			shortName: 'review',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('/snippet review old path');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('lets Escape cancel a pending expansion without changing the draft', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review cancel this' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		await fireEvent.keyDown(messageInput, { key: 'Escape' });
		expect(messageInput.value).toBe('/snippet review cancel this');
		expect(messageInput.readOnly).toBe(false);
		expect(messageInput.hasAttribute('data-local-escape-owner')).toBe(false);
		expect(onStartChat).not.toHaveBeenCalled();
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			shortName: 'review',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('/snippet review cancel this');
	});
});
