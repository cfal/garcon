import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import {
	beginTelegramRecipientLink,
	clearTelegramBotToken,
	resolveTelegramRecipientLink,
	saveTelegramBotToken,
	sendTelegramTest,
	updateRemoteSettings,
} from '$lib/api/settings.js';
	import { ApiError } from '$lib/api/client.js';
	import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import RemoteSettingsSectionTestHost from './RemoteSettingsSectionTestHost.svelte';
	import { makeTestGhCapability, setTestGhCapability } from './gh-capability-test-context';
	import { setTestRemoteSettingsStore } from './remote-settings-test-context';

vi.mock('$lib/api/settings.js', () => ({
	beginTelegramRecipientLink: vi.fn(),
	clearTelegramBotToken: vi.fn(),
	clearTelegramRecipient: vi.fn(),
	getRemoteSettings: vi.fn(),
	resolveTelegramRecipientLink: vi.fn(),
	saveTelegramBotToken: vi.fn(),
	sendTelegramTest: vi.fn(),
	testTelegramBotToken: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

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

function mockRemoteSettingsUpdate(store: RemoteSettingsStore): void {
	vi.mocked(updateRemoteSettings).mockImplementation(async (patch) => {
		const current = store.snapshot ?? makeSnapshot();
		const nextUi = {
			...current.ui,
			...(patch.ui ?? {}),
		};
		const nextUiEffective = {
			...current.uiEffective,
		};
		if (patch.ui?.chatTitle) {
			nextUiEffective.chatTitle = {
				...(current.uiEffective.chatTitle ?? {
					enabled: true,
					agentId: 'claude',
					model: 'opus',
				}),
				...patch.ui.chatTitle,
			};
		}
		if (patch.ui?.commitMessage) {
			nextUiEffective.commitMessage = {
				...(current.uiEffective.commitMessage ?? {
					agentId: 'claude',
					model: 'opus',
				}),
				...patch.ui.commitMessage,
			};
		}
		return {
			success: true,
			settings: makeSnapshot({
				...current,
				version: current.version + 1,
				ui: nextUi,
				uiEffective: nextUiEffective,
			}),
		};
	});
}

describe('RemoteSettingsSection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setTestGhCapability(makeTestGhCapability());
	});

	it('creates and resolves a Telegram recipient link without exposing a chat ID field', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				version: 1,
				telegram: {
					botTokenAvailable: true,
					botUsername: 'garcon_bot',
					botFirstName: 'Garcon',
					recipientUsername: null,
					recipientDisplayName: null,
					recipientLinked: false,
					pendingLink: false,
					linkUrl: null,
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		vi.mocked(beginTelegramRecipientLink).mockResolvedValueOnce({
			success: true,
			linkUrl: 'https://t.me/garcon_bot?start=abc',
			settings: makeSnapshot({
				version: 2,
				telegram: {
					botTokenAvailable: true,
					botUsername: 'garcon_bot',
					botFirstName: 'Garcon',
					recipientUsername: null,
					recipientDisplayName: null,
					recipientLinked: false,
					pendingLink: true,
					linkUrl: 'https://t.me/garcon_bot?start=abc',
				},
			}),
		});
		vi.mocked(resolveTelegramRecipientLink).mockResolvedValueOnce({
			success: true,
			settings: makeSnapshot({
				version: 3,
				telegram: {
					botTokenAvailable: true,
					botUsername: 'garcon_bot',
					botFirstName: 'Garcon',
					recipientUsername: 'alice',
					recipientDisplayName: 'Alice',
					recipientLinked: true,
					pendingLink: false,
					linkUrl: null,
				},
			}),
		});
		vi.mocked(sendTelegramTest).mockResolvedValueOnce({ success: true });

		render(RemoteSettingsSectionTestHost);

		expect(screen.queryByLabelText('Chat ID')).toBeNull();
		expect(screen.queryByRole('button', { name: /save token/i })).toBeNull();
		expect(screen.getByRole('button', { name: /test token/i })).toBeTruthy();

		await waitFor(() => {
			expect(beginTelegramRecipientLink).toHaveBeenCalledWith();
		});
		const setupLink = await screen.findByRole('link', {
			name: 'https://t.me/garcon_bot?start=abc',
		});
		expect(setupLink.getAttribute('href')).toBe('https://t.me/garcon_bot?start=abc');
		expect(screen.getByRole('button', { name: /send test/i })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /create link/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /open telegram/i })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: /check for user message/i }));
		expect(resolveTelegramRecipientLink).toHaveBeenCalled();
		expect((await screen.findAllByText('Linked to @alice.')).length).toBeGreaterThan(0);
		const sendTestButton = screen.getByRole('button', { name: /send test/i });
		const recipientLinkedLine = await screen.findByText('Recipient linked.');
		expect(
			sendTestButton.compareDocumentPosition(recipientLinkedLine) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		await fireEvent.click(sendTestButton);
		expect(sendTelegramTest).toHaveBeenCalled();
		const testSentLine = await screen.findByText('Test message sent.');
		expect(
			sendTestButton.compareDocumentPosition(testSentLine) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it('renders commit message settings directly below chat title generation', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				uiEffective: {
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus' },
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						useCommonDirPrefix: true,
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);

		render(RemoteSettingsSectionTestHost);

		const chatTitle = screen.getByText('Automatically generate chat titles');
		const commitModel = screen.getByText('Commit message model');
		expect(
			chatTitle.compareDocumentPosition(commitModel) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(screen.queryByText('Generate commit messages')).toBeNull();
		expect(screen.getByText('Add common directory prefix')).toBeTruthy();
		expect(screen.getByText('Generation prompt')).toBeTruthy();
	});

	it('renders custom app title below Telegram notifications', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);

		render(RemoteSettingsSectionTestHost);

		const telegramTitle = screen.getByText('Telegram notifications');
		const appTitleToggle = screen.getByText('Use custom app title');
		expect(
			telegramTitle.compareDocumentPosition(appTitleToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it('renders GitHub CLI status above pinned chats settings', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		setTestGhCapability(makeTestGhCapability());

		render(RemoteSettingsSectionTestHost);

		const githubCliTitle = screen.getByText('GitHub CLI');
		const pinnedChatsSetting = screen.getByText('Pinned chats are added to');
		expect(
			githubCliTitle.compareDocumentPosition(pinnedChatsSetting) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it('renders GitHub CLI guidance even while remote settings are loading', async () => {
		const refresh = vi.fn(() => Promise.resolve());
		setTestRemoteSettingsStore(new RemoteSettingsStore());
		setTestGhCapability(
			makeTestGhCapability({
				available: false,
				authenticated: false,
				reason: 'unauthenticated',
				login: null,
				host: null,
				hasChecked: true,
				refresh,
			}),
		);

		render(RemoteSettingsSectionTestHost);

		expect(screen.getByText('GitHub CLI')).toBeTruthy();
		expect(screen.getByText('On the Garcon host, run:')).toBeTruthy();
		expect(screen.getByText('gh auth login')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Refresh GitHub CLI status' }));
		expect(refresh).toHaveBeenCalled();
	});

	it('renders connected GitHub CLI status from the shared capability store', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		setTestGhCapability(makeTestGhCapability());

		render(RemoteSettingsSectionTestHost);

		expect(screen.getByText('Connected as octocat@github.com')).toBeTruthy();
		expect(
			screen.getByText(
				'Pull Requests is available. Garcon uses the GitHub CLI (gh) on this server.',
			),
		).toBeTruthy();
	});

	it('saves a custom app title from remote settings', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);

		render(RemoteSettingsSectionTestHost);

		await fireEvent.click(screen.getByRole('switch', { name: 'Use custom app title' }));
		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: { appIdentity: { title: 'Garcon' } },
			});
		});
		expect(screen.getByText('Changes take effect after you refresh the page.')).toBeTruthy();
		vi.mocked(updateRemoteSettings).mockClear();

		await fireEvent.click(screen.getByRole('button', { name: 'Edit app title: Garcon' }));
		const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
		expect(titleInput.value).toBe('Garcon');
		await fireEvent.input(titleInput, { target: { value: 'Garcon - Work' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Done' }));

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: { appIdentity: { title: 'Garcon - Work' } },
			});
		});
		expect(store.snapshot?.ui.appIdentity?.title).toBe('Garcon - Work');
	});

	it('rejects a blank custom app title without saving', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);

		render(RemoteSettingsSectionTestHost);

		await fireEvent.click(screen.getByRole('switch', { name: 'Use custom app title' }));
		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: { appIdentity: { title: 'Garcon' } },
			});
		});
		vi.mocked(updateRemoteSettings).mockClear();

		await fireEvent.click(screen.getByRole('button', { name: 'Edit app title: Garcon' }));
		await fireEvent.input(screen.getByLabelText('Title'), { target: { value: '   ' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Done' }));

		expect(await screen.findByText('Title is required.')).toBeTruthy();
		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('clears a saved custom app title when disabled', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot({ ui: { appIdentity: { title: 'Garcon - Work' } } }));
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);

		render(RemoteSettingsSectionTestHost);

		const titleSwitch = screen.getByRole('switch', { name: 'Use custom app title' });
		expect(titleSwitch.getAttribute('aria-checked')).toBe('true');
		await fireEvent.click(titleSwitch);

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: { appIdentity: {} },
			});
		});
		expect(screen.getByText('Changes take effect after you refresh the page.')).toBeTruthy();
		expect(store.snapshot?.ui.appIdentity).toEqual({});
	});

	it('persists the commit directory prefix setting through remote settings', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				ui: {
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						useCommonDirPrefix: true,
					},
				},
				uiEffective: {
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus' },
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						useCommonDirPrefix: true,
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);

		render(RemoteSettingsSectionTestHost);

		await fireEvent.click(
			screen.getByRole('switch', {
				name: 'Prefix generated commit messages with the common directory',
			}),
		);

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: {
					commitMessage: expect.objectContaining({
						agentId: 'codex',
						model: 'gpt-5.4',
						useCommonDirPrefix: false,
					}),
				},
			});
		});
	});

	it('persists and restores the commit generation prompt', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				ui: {
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						customPrompt: '',
					},
				},
				uiEffective: {
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus' },
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						customPrompt: '',
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);

		render(RemoteSettingsSectionTestHost);

		const prompt = screen.getByLabelText('Generation prompt');
		await fireEvent.input(prompt, { target: { value: 'Summarize {{files}} with {{diff}}' } });
		await fireEvent.blur(prompt);

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: {
					commitMessage: expect.objectContaining({
						customPrompt: 'Summarize {{files}} with {{diff}}',
					}),
				},
			});
		});

		const restoreButton = await screen.findByRole('button', { name: 'Restore default prompt' });
		const prefixLabel = screen.getByText('Add common directory prefix');
		expect(
			restoreButton.compareDocumentPosition(prefixLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		await fireEvent.click(restoreButton);

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenLastCalledWith({
				ui: {
					commitMessage: expect.objectContaining({
						customPrompt: '',
					}),
				},
			});
		});
	});

	it('saves the Telegram bot token and applies the redacted settings snapshot', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot({ version: 1 }));
		setTestRemoteSettingsStore(store);
		vi.mocked(saveTelegramBotToken).mockResolvedValueOnce({
			success: true,
			settings: makeSnapshot({
				version: 2,
				telegram: {
					botTokenAvailable: true,
					botUsername: 'garcon_bot',
					botFirstName: 'Garcon',
					recipientUsername: null,
					recipientDisplayName: null,
					recipientLinked: false,
					pendingLink: true,
					linkUrl: 'https://t.me/garcon_bot?start=abc',
				},
			}),
		});

		render(RemoteSettingsSectionTestHost);

		const input = await screen.findByLabelText('Bot token');
		expect(screen.queryByRole('button', { name: /test token/i })).toBeNull();
		expect(
			(screen.getByRole('button', { name: /clear token/i }) as HTMLButtonElement).disabled,
		).toBe(true);
		await fireEvent.input(input, { target: { value: 'secret-token' } });
		await fireEvent.click(screen.getByRole('button', { name: /save token/i }));

		expect(saveTelegramBotToken).toHaveBeenCalledWith('secret-token');
		expect(store.snapshot?.telegram.botTokenAvailable).toBe(true);
		expect(
			await screen.findByRole('link', { name: 'https://t.me/garcon_bot?start=abc' }),
		).toBeTruthy();
		expect(screen.queryByText('Token saved for @garcon_bot.')).toBeNull();
		expect(screen.queryByText('Connected as @garcon_bot.')).toBeNull();
		expect(screen.queryByRole('button', { name: /save token/i })).toBeNull();
		expect(screen.getByRole('button', { name: /test token/i })).toBeTruthy();
		expect(
			(screen.getByRole('button', { name: /clear token/i }) as HTMLButtonElement).disabled,
		).toBe(false);
		expect((input as HTMLInputElement).disabled).toBe(true);
		expect(beginTelegramRecipientLink).not.toHaveBeenCalled();
		expect(screen.queryByDisplayValue('secret-token')).toBeNull();
	});

	it('clears the Telegram token and returns to the unset token actions', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				version: 1,
				ui: { notifications: { telegram: { enabled: true } } },
				telegram: {
					botTokenAvailable: true,
					botUsername: 'garcon_bot',
					botFirstName: 'Garcon',
					recipientUsername: 'alice',
					recipientDisplayName: 'Alice',
					recipientLinked: true,
					pendingLink: false,
					linkUrl: null,
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		vi.mocked(clearTelegramBotToken).mockResolvedValueOnce({
			success: true,
			settings: makeSnapshot({
				version: 2,
				ui: { notifications: { telegram: { enabled: false } } },
			}),
		});

		render(RemoteSettingsSectionTestHost);

		await fireEvent.click(screen.getByRole('button', { name: /clear token/i }));

		expect(clearTelegramBotToken).toHaveBeenCalled();
		expect(store.snapshot?.telegram.botTokenAvailable).toBe(false);
		expect(store.snapshot?.ui.notifications?.telegram?.enabled).toBe(false);
		expect(screen.getByRole('button', { name: /save token/i })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /test token/i })).toBeNull();
		expect(
			(screen.getByRole('button', { name: /clear token/i }) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it('shows the token validation error code when saving fails', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot({ version: 1 }));
		setTestRemoteSettingsStore(store);
		vi.mocked(saveTelegramBotToken).mockRejectedValueOnce(
			new ApiError(400, 'Raw server token failure', 'telegram_token_test_failed', 'Unauthorized'),
		);

		render(RemoteSettingsSectionTestHost);

		const input = await screen.findByLabelText('Bot token');
		await fireEvent.input(input, { target: { value: 'bad-token' } });
		await fireEvent.click(screen.getByRole('button', { name: /save token/i }));

		expect(saveTelegramBotToken).toHaveBeenCalledWith('bad-token');
		expect(
			await screen.findByText(
				'Telegram token test failed: Unauthorized (telegram_token_test_failed)',
			),
		).toBeTruthy();
		expect(screen.queryByText(/Raw server token failure/)).toBeNull();
		expect(store.snapshot?.telegram.botTokenAvailable).toBe(false);
		expect(beginTelegramRecipientLink).not.toHaveBeenCalled();
	});
});
