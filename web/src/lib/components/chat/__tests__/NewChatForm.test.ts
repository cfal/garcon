import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewChatFormTestHost from './NewChatFormTestHost.svelte';
import * as settingsApi from '$lib/api/settings';
import * as gitApi from '$lib/api/git';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import * as snippetsApi from '$lib/api/snippets';
import * as clientChatId from '$shared/client-chat-id';
import { parseChatId } from '$shared/chat-id';
import { DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID } from '$shared/agents';

const PROSPECTIVE_CHAT_ID = parseChatId('1787471053739199');
const RESEEDED_CHAT_ID = parseChatId('1787471053739200');

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn(),
}));

vi.mock('$lib/api/chat-preambles', () => ({
	preambleSelectionPreview: vi.fn(async (request: { projectPath: string }) => ({
		success: true,
		canonicalProjectPath: request.projectPath,
		orderedPreambleIds: [],
		projection: { catalogRevision: 0, eligiblePreambles: [], unavailable: [] },
	})),
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

vi.mock('$shared/client-chat-id', () => ({
	createClientChatId: vi.fn(() => '1787471053739199'),
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
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true },
		},
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
				agentSettingsById: {},
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

async function renderSubmittableForm(
	onStartChat: () => void,
	props: {
		supportsImages?: boolean;
		snippetTrigger?: string;
		snippetTemplate?: string;
		snippetDefaultArguments?: string;
	} = {},
): Promise<HTMLTextAreaElement> {
	const chatsApi = await import('$lib/api/chats');
	vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });
	vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
		makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
	);

	render(NewChatFormTestHost, { props: { ...props, onStartChat } });

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

async function inputAtCaret(
	textarea: HTMLTextAreaElement,
	value: string,
	caret: number,
	eventInit: InputEventInit = {},
): Promise<void> {
	textarea.value = value;
	textarea.setSelectionRange(caret, caret);
	await fireEvent.input(textarea, eventInit);
}

describe('NewChatForm', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.mocked(snippetsApi.expandSnippet).mockReset();
		vi.mocked(clientChatId.createClientChatId).mockReset();
		vi.mocked(clientChatId.createClientChatId).mockReturnValue(PROSPECTIVE_CHAT_ID);
	});

	it('cancels pending reseed focus when unmounted', () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValue(new Promise(() => {}));
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const view = render(NewChatFormTestHost, { props: { onStartChat: vi.fn() } });
		const focusTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 50);

		expect(focusTimerIndex).toBeGreaterThanOrEqual(0);
		const focusTimer = setTimeoutSpy.mock.results[focusTimerIndex]?.value;
		view.unmount();

		expect(clearTimeoutSpy).toHaveBeenCalledWith(focusTimer);
		setTimeoutSpy.mockRestore();
		clearTimeoutSpy.mockRestore();
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
		expect(onStartChat.mock.calls[0]?.[1]).toBe(PROSPECTIVE_CHAT_ID);
	});

	it('blocks click and Enter after the selected endpoint disappears', async () => {
		stubMatchMedia(false);
		const chatsApi = await import('$lib/api/chats');
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				paths: { recentProjectPaths: ['/workspace/project'] },
				recentAgentSettings: [
					{
						agentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
						model: 'chat-model',
						apiProviderId: 'test-provider',
						modelEndpointId: 'test_openai',
						modelProtocol: 'openai-compatible',
					},
				],
			}),
		);
		const onStartChat = vi.fn();
		const view = render(NewChatFormTestHost, {
			props: {
				allowDirectChats: true,
				endpointBackedDirectModel: true,
				modelsAvailable: true,
				onStartChat,
			},
		});

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const messageInput = screen.getByPlaceholderText('How can I help you today?');
		await fireEvent.input(messageInput, { target: { value: 'first line' } });
		await waitFor(() => {
			expect((screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled).toBe(
				false,
			);
		});

		await view.rerender({ catalogVersion: 1, modelsAvailable: false });

		const submit = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
		await waitFor(() => {
			expect(screen.getByText('Model unavailable')).toBeTruthy();
			expect(submit.disabled).toBe(true);
		});
		await fireEvent.click(submit);
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).not.toHaveBeenCalled();
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

	it('renders agent thinking as a toolbar button instead of a combobox', async () => {
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({ paths: { recentProjectPaths: ['/workspace/project'] } }),
		);

		render(NewChatFormTestHost);

		const thinkingButton = await screen.findByRole('button', { name: 'Thinking: Auto' });
		expect(screen.queryByRole('combobox', { name: 'Thinking' })).toBeNull();
		expect(thinkingButton.closest('[data-slot="composer-bottom-bar"]')).toBeTruthy();

		await fireEvent.click(thinkingButton);
		const options = await screen.findAllByRole('menuitemradio');
		expect(options.map((option) => option.querySelector('.font-medium')?.textContent)).toEqual([
			'Auto',
			'On',
			'Off',
		]);
		expect(screen.getByText('Lets Claude decide when extended thinking is useful.')).toBeTruthy();
		expect(screen.getByText('Uses extended thinking for every response.')).toBeTruthy();
		expect(screen.getByText('Answers without extended thinking.')).toBeTruthy();
		await fireEvent.click(screen.getByRole('menuitemradio', { name: /^On/ }));
		expect(screen.getByRole('button', { name: 'Thinking: On' })).toBeTruthy();
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

	it('hides direct agents and direct recents when direct chats are disabled', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'direct-openai-compatible',
						model: 'chat-model',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
					{
						agentId: 'claude',
						model: 'opus',
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

		expect(
			document.querySelector('[data-slot="model-selector-agent-group"][data-group="direct"]'),
		).toBeNull();
		expect(
			document.querySelector('[data-slot="model-selector-agent-group"][data-group="agents"]'),
		).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Chat Completions' })).toBeNull();
		expect(screen.queryByText('Direct (Chat Completions) · Chat Model')).toBeNull();
	});

	it('shows grouped direct agents when direct chats are enabled', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'direct-openai-compatible',
						model: 'chat-model',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
			}),
		);

		render(NewChatFormTestHost, { allowDirectChats: true });

		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const trigger = screen.getByRole('button', {
			name: /Direct \(Chat Completions\).*Chat Model/,
		});
		await fireEvent.click(trigger);

		const groupHeaders = Array.from(
			document.querySelectorAll<HTMLElement>('[data-slot="model-selector-agent-group"]'),
		);
		expect(groupHeaders.map((header) => header.textContent?.trim())).toEqual(['Direct', 'Agents']);
		expect(screen.getByRole('button', { name: 'Chat Completions' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Responses' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Anthropic' })).toBeTruthy();
	});

	it('reconciles an open direct selection when direct chats are disabled', async () => {
		stubMatchMedia(false);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValueOnce(
			makeSnapshot({
				recentAgentSettings: [
					{
						agentId: 'direct-openai-compatible',
						model: 'chat-model',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
					{
						agentId: 'claude',
						model: 'opus',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
					},
				],
			}),
		);

		const view = render(NewChatFormTestHost, { allowDirectChats: true });
		await waitFor(() => {
			expect(
				screen.getByRole('button', {
					name: /Direct \(Chat Completions\).*Chat Model/,
				}),
			).toBeTruthy();
		});

		await view.rerender({ allowDirectChats: false });

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Claude .* Opus/ })).toBeTruthy();
		});
		expect(
			screen.queryByRole('button', {
				name: /Direct \(Chat Completions\).*Chat Model/,
			}),
		).toBeNull();
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
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'Review the API in /workspace/project',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review the API' } });

		const start = screen.getByRole('button', { name: 'Start session' });
		start.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(messageInput);

		await waitFor(() => expect(messageInput.value).toBe('Review the API in /workspace/project'));
		expect(onStartChat).not.toHaveBeenCalled();
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: { type: 'value', value: 'the API' },
				context: {
					type: 'new-chat',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).toHaveBeenCalledTimes(1);
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({ firstMessage: 'Review the API in /workspace/project' }),
			PROSPECTIVE_CHAT_ID,
		);
	});

	it('mints the prospective ID lazily and clears it on reseed', async () => {
		stubMatchMedia(false);
		vi.mocked(clientChatId.createClientChatId)
			.mockReset()
			.mockReturnValueOnce(PROSPECTIVE_CHAT_ID)
			.mockReturnValueOnce(RESEEDED_CHAT_ID);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'expanded prompt',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);

		await fireEvent.input(messageInput, { target: { value: '/snippet review first' } });
		expect(clientChatId.createClientChatId).not.toHaveBeenCalled();
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await waitFor(() => expect(messageInput.value).toBe('expanded prompt'));
		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(1);
		await fireEvent.input(messageInput, { target: { value: 'edited prompt' } });
		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(1);

		await fireEvent.click(screen.getByTestId('reseed-new-chat'));
		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(1);
		await fireEvent.input(messageInput, { target: { value: 'after reseed' } });
		await waitFor(() => {
			expect(
				(screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
			).toBe(false);
		});
		await fireEvent.keyDown(messageInput, { key: 'Enter' });

		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(2);
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({ firstMessage: 'after reseed' }),
			RESEEDED_CHAT_ID,
		);
	});

	it('cancels an in-flight expansion on reseed', async () => {
		stubMatchMedia(false);
		vi.mocked(clientChatId.createClientChatId)
			.mockReset()
			.mockReturnValueOnce(PROSPECTIVE_CHAT_ID)
			.mockReturnValueOnce(RESEEDED_CHAT_ID);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review stale ID' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		await fireEvent.click(screen.getByTestId('reseed-new-chat'));
		await fireEvent.input(messageInput, { target: { value: 'after reseed' } });
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('after reseed');
		await waitFor(() => {
			expect(
				(screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
			).toBe(false);
		});
		await fireEvent.keyDown(messageInput, { key: 'Enter' });

		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			expect.objectContaining({
				context: expect.objectContaining({ chatId: PROSPECTIVE_CHAT_ID }),
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(onStartChat).toHaveBeenCalledWith(
			expect.objectContaining({ firstMessage: 'after reseed' }),
			RESEEDED_CHAT_ID,
		);
	});

	it('distinguishes omitted slash arguments from an explicit empty value', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValue({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'expanded',
		});
		const messageInput = await renderSubmittableForm(vi.fn());

		await fireEvent.input(messageInput, { target: { value: '/s review' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await waitFor(() => expect(messageInput.value).toBe('expanded'));
		await fireEvent.input(messageInput, { target: { value: '/s review ' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await waitFor(() => expect(messageInput.value).toBe('expanded'));

		expect(snippetsApi.expandSnippet).toHaveBeenNthCalledWith(
			1,
			{
				shortName: 'review',
				arguments: { type: 'default' },
				context: {
					type: 'new-chat',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(snippetsApi.expandSnippet).toHaveBeenNthCalledWith(
			2,
			{
				shortName: 'review',
				arguments: { type: 'value', value: '' },
				context: {
					type: 'new-chat',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('opens from an inline trigger and replaces the captured span in the first message', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'EXPANDED',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat, {
			snippetTemplate: 'Expanded review',
		});
		const source = 'Before ;;review after';

		await inputAtCaret(messageInput, source, 'Before ;;review'.length);
		const search = (await screen.findByRole('combobox', {
			name: 'Search snippets',
		})) as HTMLInputElement;
		expect(search.value).toBe('review');
		await fireEvent.click(screen.getByRole('option', { name: /^review\b/ }));

		await waitFor(() => expect(messageInput.value).toBe('Before EXPANDED after'));
		expect(messageInput.selectionStart).toBe('Before EXPANDED'.length);
		expect(onStartChat).not.toHaveBeenCalled();
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: { type: 'value', value: '' },
				context: {
					type: 'new-chat',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('inserts an unchanged saved default as an explicit palette value', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'EXPANDED',
		});
		const messageInput = await renderSubmittableForm(vi.fn(), {
			snippetDefaultArguments: 'saved default',
		});
		await fireEvent.input(messageInput, { target: { value: 'Before replace after' } });
		messageInput.setSelectionRange(7, 14);
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = (await screen.findByRole('textbox', {
			name: 'Arguments',
		})) as HTMLTextAreaElement;
		expect(argumentsInput.value).toBe('saved default');
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await waitFor(() => expect(messageInput.value).toBe('Before EXPANDED after'));
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			{
				shortName: 'review',
				arguments: { type: 'value', value: 'saved default' },
				context: {
					type: 'new-chat',
					chatId: PROSPECTIVE_CHAT_ID,
					projectPath: '/workspace/project',
				},
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
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
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'new chat draft' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText('That snippet changed. Select it again.');
		await waitFor(() => expect(screen.getByTestId('snippet-load-count').textContent).toBe('2'));
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('rejects a menu expansion when the selected snippet was edited in place', async () => {
		stubMatchMedia(false);
		vi.mocked(snippetsApi.expandSnippet).mockResolvedValueOnce({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-02T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'new chat draft' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });

		await screen.findByText('That snippet changed. Select it again.');
		await waitFor(() => expect(screen.getByTestId('snippet-load-count').textContent).toBe('2'));
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('explains and blocks palette insertion when no project path is set', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.input(screen.getByRole('textbox', { name: 'Project Path' }), {
			target: { value: '   ' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await screen.findByText('Set a project path to insert snippets');
		const option = screen.getByRole('option', { name: /^review/ });
		expect(option.getAttribute('aria-disabled')).toBe('true');
		await fireEvent.click(option);

		expect(screen.getByRole('dialog', { name: 'Insert Snippet' })).toBeTruthy();
		expect(snippetsApi.expandSnippet).not.toHaveBeenCalled();
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('does not let late path validation steal focus from argument entry', async () => {
		stubMatchMedia(false);
		const onStartChat = vi.fn();
		await renderSubmittableForm(onStartChat);
		const chatsApi = await import('$lib/api/chats');
		const pendingValidation = deferred<Awaited<ReturnType<typeof chatsApi.validateStart>>>();
		const validationCallCount = vi.mocked(chatsApi.validateStart).mock.calls.length;
		vi.mocked(chatsApi.validateStart).mockReturnValueOnce(pendingValidation.promise);
		await fireEvent.input(screen.getByRole('textbox', { name: 'Project Path' }), {
			target: { value: '/workspace/next' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await waitFor(() =>
			expect(chatsApi.validateStart).toHaveBeenCalledTimes(validationCallCount + 1),
		);

		pendingValidation.resolve({ valid: true, isGitRepo: false });
		await pendingValidation.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await waitFor(() => expect(document.activeElement).toBe(argumentsInput));
		expect(screen.getByRole('dialog', { name: 'Arguments for /snippet review' })).toBeTruthy();
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

		const pathInput = screen.getByRole('textbox', { name: 'Project Path' });
		await fireEvent.input(pathInput, { target: { value: '/workspace/other' } });
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('/snippet review old path');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('keeps the composer editable and cancels a pending expansion when the user types', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'cancellable' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });
		expect(document.activeElement).toBe(messageInput);
		expect(messageInput.readOnly).toBe(false);
		const pendingEnter = new KeyboardEvent('keydown', {
			key: 'Enter',
			bubbles: true,
			cancelable: true,
		});
		messageInput.dispatchEvent(pendingEnter);
		expect(pendingEnter.defaultPrevented).toBe(true);

		await fireEvent.input(messageInput, { target: { value: 'User edit wins' } });
		expect(messageInput.value).toBe('User edit wins');
		expect(messageInput.readOnly).toBe(false);
		expect(onStartChat).not.toHaveBeenCalled();
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('User edit wins');
	});

	it('accepts a pasted image and cancels a pending expansion', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'cancellable' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		const attachment = new File(['image'], 'pasted.png', { type: 'image/png' });
		await fireEvent.paste(messageInput, {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile: () => attachment }],
			},
		});

		expect(screen.getByRole('button', { name: 'Remove attachment pasted.png' })).toBeTruthy();
		const expansionOptions = vi.mocked(snippetsApi.expandSnippet).mock.calls[0]?.[1];
		expect(expansionOptions?.signal?.aborted).toBe(true);
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('Keep this draft');
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('ignores an unsupported pasted image without cancelling a pending expansion', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat, { supportsImages: false });
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: /Snippets/ }));
		await fireEvent.click(await screen.findByRole('option', { name: /^review/ }));
		const argumentsInput = await screen.findByRole('textbox', { name: 'Arguments' });
		await fireEvent.input(argumentsInput, { target: { value: 'still running' } });
		await fireEvent.keyDown(argumentsInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		const attachment = new File(['image'], 'unsupported.png', { type: 'image/png' });
		await fireEvent.paste(messageInput, {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile: () => attachment }],
			},
		});

		expect(screen.queryByRole('button', { name: 'Remove attachment unsupported.png' })).toBeNull();
		const expansionOptions = vi.mocked(snippetsApi.expandSnippet).mock.calls[0]?.[1];
		expect(expansionOptions?.signal?.aborted).toBe(false);
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'expansion still applies',
		});

		await pending.promise;
		await waitFor(() => expect(messageInput.value).toContain('expansion still applies'));
		expect(onStartChat).not.toHaveBeenCalled();
	});

	it('lets another form control cancel a pending expansion with Escape', async () => {
		stubMatchMedia(false);
		const pending = deferred<Awaited<ReturnType<typeof snippetsApi.expandSnippet>>>();
		vi.mocked(snippetsApi.expandSnippet).mockReturnValueOnce(pending.promise);
		const onStartChat = vi.fn();
		const messageInput = await renderSubmittableForm(onStartChat);
		await fireEvent.input(messageInput, { target: { value: '/snippet review cancel this' } });
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		await screen.findByRole('button', { name: 'Expanding snippet' });

		const permissionButton = screen.getAllByTitle('Default')[0];
		expect(permissionButton).toBeTruthy();
		if (!permissionButton) throw new Error('Missing permission control');
		permissionButton.focus();
		await fireEvent.keyDown(permissionButton, { key: 'Escape' });

		expect(messageInput.value).toBe('/snippet review cancel this');
		expect(messageInput.readOnly).toBe(false);
		expect(onStartChat).not.toHaveBeenCalled();
		pending.resolve({
			success: true,
			snippetId: 'snippet-review',
			snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
			shortName: 'review',
			contextProjectPath: '/workspace/project',
			expandedText: 'must not apply',
		});

		await pending.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(messageInput.value).toBe('/snippet review cancel this');
	});
});
