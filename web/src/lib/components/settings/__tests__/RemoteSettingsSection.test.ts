import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import {
	beginTelegramRecipientLink,
	clearTelegramBotToken,
	resolveTelegramRecipientLink,
	saveTelegramBotToken,
	sendTelegramTest,
	testGenerationModel,
	updateRemoteSettings,
} from '$lib/api/settings.js';
import { ApiError } from '$lib/api/client.js';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import RemoteSettingsSectionTestHost from './RemoteSettingsSectionTestHost.svelte';
import { makeTestGhCapability, setTestGhCapability } from './gh-capability-test-context';
import { setTestRemoteSettingsStore } from './remote-settings-test-context';
import { generationModelTestConfigurationKey } from '$shared/generation-test-contracts';
import {
	DEFAULT_COMMIT_MESSAGE_PROMPT,
	DEFAULT_PROMPT_REFINEMENT_PROMPT,
	GENERATION_PROMPT_TEMPLATE_MAX_LENGTH,
} from '$shared/generation-prompts';

vi.mock('$lib/api/settings.js', () => ({
	beginTelegramRecipientLink: vi.fn(),
	clearTelegramBotToken: vi.fn(),
	clearTelegramRecipient: vi.fn(),
	getRemoteSettings: vi.fn(),
	resolveTelegramRecipientLink: vi.fn(),
	saveTelegramBotToken: vi.fn(),
	sendTelegramTest: vi.fn(),
	testTelegramBotToken: vi.fn(),
	testGenerationModel: vi.fn(),
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
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: {
				enabled: true,
				chatIdDiscovery: true,
				sendMessage: true,
			},
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
		const nextFeatures = {
			...current.features,
			transcriptSearch: {
				...current.features.transcriptSearch,
				...(patch.features?.transcriptSearch ?? {}),
			},
			agentCommands: {
				...current.features.agentCommands,
				...(patch.features?.agentCommands ?? {}),
			},
		};
		if (patch.ui?.chatTitle) {
			nextUiEffective.chatTitle = {
				...(current.uiEffective.chatTitle ?? {
					enabled: true,
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
				}),
				...patch.ui.chatTitle,
			};
		}
		if (patch.ui?.agentSwitchCompaction) {
			nextUiEffective.agentSwitchCompaction = {
				...(current.uiEffective.agentSwitchCompaction ?? {
					enabled: false,
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
					contextWindowTokens: 500_000,
				}),
				...patch.ui.agentSwitchCompaction,
			};
		}
		if (patch.ui?.commitMessage) {
			nextUiEffective.commitMessage = {
				...(current.uiEffective.commitMessage ?? {
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
				}),
				...patch.ui.commitMessage,
			};
		}
		if (patch.ui?.promptRefinement) {
			nextUiEffective.promptRefinement = {
				...(current.uiEffective.promptRefinement ?? {
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
				}),
				...patch.ui.promptRefinement,
			};
		}
		return {
			success: true,
			settings: makeSnapshot({
				...current,
				version: current.version + 1,
				ui: nextUi,
				uiEffective: nextUiEffective,
				features: nextFeatures,
			}),
		};
	});
}

describe('RemoteSettingsSection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setTestGhCapability(makeTestGhCapability());
	});

	it('enables transcript search through the remote feature patch', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);
		render(RemoteSettingsSectionTestHost);

		const toggle = screen.getByRole('switch', { name: 'Transcript search' });
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(toggle);

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				features: { transcriptSearch: { enabled: true } },
			});
			expect(store.snapshot?.features.transcriptSearch.enabled).toBe(true);
		});
	});

	it('shows the hidden bash commands card while remote settings have not loaded', () => {
		setTestRemoteSettingsStore(new RemoteSettingsStore());
		render(RemoteSettingsSectionTestHost);

		expect(screen.getByText('Hide bash commands')).toBeTruthy();
		expect(screen.getByLabelText('Command pattern')).toBeTruthy();
	});

	it('persists agent command settings while the parent hides and restores them', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);
		render(RemoteSettingsSectionTestHost);

		const parent = screen.getByRole('switch', { name: 'Enable agent commands' });
		expect(parent.getAttribute('aria-checked')).toBe('true');
		expect(screen.getByText(/Allows agents to discover chat IDs/)).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Learn more in Garcon Skills' }).getAttribute('href')).toBe(
			'https://github.com/cfal/garcon-skills',
		);
		expect(screen.getByRole('switch', { name: 'Enable chat ID auto-discovery' })).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'Enable send message' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('switch', { name: 'Enable send message' }));

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				features: { agentCommands: { sendMessage: false } },
			});
			expect(store.snapshot?.features.agentCommands.sendMessage).toBe(false);
		});

		await fireEvent.click(parent);
		await waitFor(() => {
			expect(store.snapshot?.features.agentCommands.enabled).toBe(false);
			expect(screen.queryByRole('switch', { name: 'Enable send message' })).toBeNull();
		});
		expect(store.snapshot?.features.agentCommands.sendMessage).toBe(false);

		await fireEvent.click(parent);
		await waitFor(() => {
			expect(store.snapshot?.features.agentCommands.enabled).toBe(true);
			expect(screen.getByRole('switch', { name: 'Enable send message' }).getAttribute('aria-checked'))
				.toBe('false');
		});
	});

	it('keeps agent command state unchanged when saving fails', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		vi.mocked(updateRemoteSettings).mockRejectedValueOnce(new Error('Settings are unavailable.'));
		render(RemoteSettingsSectionTestHost);

		const toggle = screen.getByRole('switch', { name: 'Enable send message' });
		await fireEvent.click(toggle);

		expect((await screen.findByRole('alert')).textContent).toContain('Settings are unavailable.');
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		expect(store.snapshot?.features.agentCommands.sendMessage).toBe(true);
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

	it('renders prompt refinement after commit generation without an enabled switch', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				uiEffective: {
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus', thinkingMode: 'none' },
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						thinkingMode: 'none',
						useCommonDirPrefix: true,
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);

		render(RemoteSettingsSectionTestHost);

		const chatTitle = screen.getByText('Automatically generate chat titles');
		const compactionToggle = screen.getByText('Enable agent switch compaction');
		const commitModel = screen.getByText('Commit message model');
		const refinementModel = screen.getByText('Prompt refinement model');
		expect(
			compactionToggle.compareDocumentPosition(commitModel)
				& Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			chatTitle.compareDocumentPosition(commitModel) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			commitModel.compareDocumentPosition(refinementModel)
				& Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(screen.queryByText('Generate commit messages')).toBeNull();
		expect(screen.getByText('Add common directory prefix')).toBeTruthy();
		expect(screen.queryByRole('textbox', { name: /generation prompt/i })).toBeNull();
		expect(screen.getAllByRole('button', { name: 'Edit generation prompt' })).toHaveLength(2);
		expect(screen.getAllByRole('button', { name: 'Test model' })).toHaveLength(3);
		expect(refinementModel.parentElement?.parentElement?.querySelector('[role="switch"]')).toBeNull();
	});

	it('configures the compaction context window and preserves it across nested saves', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				ui: {
					agentSwitchCompaction: {
						enabled: true,
						agentId: 'claude',
						model: 'opus',
						thinkingMode: 'none',
					},
				},
				uiEffective: {
					agentSwitchCompaction: {
						enabled: true,
						agentId: 'claude',
						model: 'opus',
						thinkingMode: 'none',
						contextWindowTokens: 500_000,
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);
		render(RemoteSettingsSectionTestHost);

		const selector = screen.getByRole('combobox', {
			name: 'Compaction model context window',
		}) as HTMLSelectElement;
		expect(Array.from(selector.options).map(({ value, text }) => ({ value, text }))).toEqual([
			{ value: '200000', text: '200,000 tokens' },
			{ value: '500000', text: '500,000 tokens (default)' },
			{ value: '1000000', text: '1,000,000 tokens' },
		]);
		expect(selector.value).toBe('500000');

		await fireEvent.change(selector, { target: { value: '200000' } });
		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenLastCalledWith({
				ui: {
					agentSwitchCompaction: {
						enabled: true,
						agentId: 'claude',
						model: 'opus',
						apiProviderId: null,
						modelEndpointId: null,
						modelProtocol: null,
						thinkingMode: 'none',
						contextWindowTokens: 200_000,
					},
				},
			});
		});

		vi.mocked(updateRemoteSettings).mockClear();
		const card = screen.getByText('Compaction model').closest('.rounded-lg');
		expect(card).toBeTruthy();
		await fireEvent.click(
			within(card as HTMLElement).getByRole('button', { name: /Claude .* Opus .* Default/ }),
		);
		await fireEvent.click(await screen.findByRole('button', { name: /High Thorough reasoning/ }));
		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenLastCalledWith({
				ui: {
					agentSwitchCompaction: expect.objectContaining({
						thinkingMode: 'high',
						contextWindowTokens: 200_000,
					}),
				},
			});
		});

		vi.mocked(updateRemoteSettings).mockClear();
		await fireEvent.click(screen.getByRole('switch', { name: 'Enable agent switch compaction' }));
		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenLastCalledWith({
				ui: {
					agentSwitchCompaction: expect.objectContaining({
						enabled: false,
						contextWindowTokens: 200_000,
					}),
				},
			});
		});
	});

	it('disables the compaction context-window selector while saving', async () => {
		const store = new RemoteSettingsStore();
		const snapshot = makeSnapshot({
			uiEffective: {
				agentSwitchCompaction: {
					enabled: true,
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'none',
					contextWindowTokens: 500_000,
				},
			},
		});
		store.applySnapshot(snapshot);
		setTestRemoteSettingsStore(store);
		let finishSave!: () => void;
		vi.mocked(updateRemoteSettings).mockImplementationOnce(
			() => new Promise((resolve) => {
				finishSave = () => resolve({
					success: true,
					settings: snapshot,
				});
			}),
		);
		render(RemoteSettingsSectionTestHost);

		const selector = screen.getByRole('combobox', {
			name: 'Compaction model context window',
		}) as HTMLSelectElement;
		await fireEvent.change(selector, { target: { value: '200000' } });
		await waitFor(() => expect(selector.disabled).toBe(true));
		finishSave();
		await waitFor(() => expect(selector.disabled).toBe(false));
	});

	it('keeps direct agents available in title and commit generation selectors', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				uiEffective: {
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus', thinkingMode: 'none' },
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						thinkingMode: 'none',
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);

		render(RemoteSettingsSectionTestHost);

		const [titleTrigger] = screen.getAllByRole('button', {
			name: /Claude .* Opus .* Default/,
		});
		await fireEvent.click(titleTrigger);
		let groupHeaders = Array.from(
			document.querySelectorAll<HTMLElement>('[data-slot="model-selector-agent-group"]'),
		);
		expect(groupHeaders.map((header) => header.textContent?.trim())).toEqual(['Direct', 'Agents']);
		expect(screen.getByRole('button', { name: 'Chat Completions' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Responses' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Anthropic' })).toBeTruthy();

		await fireEvent.click(titleTrigger);
		await waitFor(() => {
			expect(document.querySelectorAll('[data-slot="model-selector-agent-group"]')).toHaveLength(0);
		});

		await fireEvent.click(screen.getByRole('button', { name: /Codex .* GPT-5.4 .* Default/ }));
		groupHeaders = Array.from(
			document.querySelectorAll<HTMLElement>('[data-slot="model-selector-agent-group"]'),
		);
		expect(groupHeaders.map((header) => header.textContent?.trim())).toEqual(['Direct', 'Agents']);
	});

	it('tests title, commit, and prompt-refinement models independently', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				uiEffective: {
					chatTitle: {
						enabled: true,
						agentId: 'claude',
						model: 'opus',
						thinkingMode: 'high',
					},
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						thinkingMode: 'max',
					},
					promptRefinement: {
						agentId: 'amp',
						model: 'smart',
						thinkingMode: 'none',
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		vi.mocked(testGenerationModel)
			.mockResolvedValueOnce({ success: true, target: 'chatTitle', durationMs: 8_432 })
			.mockRejectedValueOnce(
				new ApiError(422, 'unsupported', 'GENERATION_TEST_UNSUPPORTED_EFFORT'),
			)
			.mockRejectedValueOnce(
				new ApiError(422, 'unsafe', 'GENERATION_TEST_UNSAFE_AGENT'),
			);

		render(RemoteSettingsSectionTestHost);

		const [titleTestButton, commitTestButton, refinementTestButton] = screen.getAllByRole('button', {
			name: 'Test model',
		});
		const [titleTestStatus] = screen.getAllByRole('status');
		expect(titleTestStatus.textContent).toBe('');
		await fireEvent.click(titleTestButton);
		await screen.findByText('Model responded in 8.4 s.');
		expect(titleTestStatus.textContent).toBe('Model responded in 8.4 s.');
		expect(testGenerationModel).toHaveBeenNthCalledWith(1, 'chatTitle', expect.any(String));

		await fireEvent.click(commitTestButton);
		await screen.findByText('This agent cannot use the selected effort for one-shot generation.');
		expect(testGenerationModel).toHaveBeenNthCalledWith(2, 'commitMessage', expect.any(String));

		await fireEvent.click(refinementTestButton);
		await screen.findByText(
			'This agent can run tools without asking permission. Choose a safer agent for prompt refinement.',
		);
		expect(testGenerationModel).toHaveBeenNthCalledWith(3, 'promptRefinement', expect.any(String));
	});

	it('tests an out-of-catalog Direct selection with its displayed endpoint metadata', async () => {
		const store = new RemoteSettingsStore();
		const chatTitle = {
			enabled: true,
			agentId: 'direct-openai-compatible',
			model: 'removed-from-catalog',
			apiProviderId: 'custom-provider',
			modelEndpointId: 'custom-endpoint',
			modelProtocol: 'openai-compatible' as const,
			thinkingMode: 'max' as const,
		};
		store.applySnapshot(
			makeSnapshot({
				ui: { chatTitle },
				uiEffective: { chatTitle },
			}),
		);
		setTestRemoteSettingsStore(store);
		vi.mocked(testGenerationModel).mockResolvedValueOnce({
			success: true,
			target: 'chatTitle',
			durationMs: 12,
		});

		render(RemoteSettingsSectionTestHost);
		await fireEvent.click(screen.getAllByRole('button', { name: 'Test model' })[0]);

		await waitFor(() => {
			expect(testGenerationModel).toHaveBeenCalledWith(
				'chatTitle',
				generationModelTestConfigurationKey(chatTitle),
			);
		});
	});

	it('keeps the Test model button name while a request is running', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				uiEffective: {
					chatTitle: {
						enabled: true,
						agentId: 'claude',
						model: 'opus',
						thinkingMode: 'none',
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		let resolveTest!: (value: { success: true; target: 'chatTitle'; durationMs: number }) => void;
		vi.mocked(testGenerationModel).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveTest = resolve;
				}),
		);

		render(RemoteSettingsSectionTestHost);
		const testButton = screen.getAllByRole('button', { name: 'Test model' })[0];
		await fireEvent.click(testButton);

		await waitFor(() => expect(testButton.getAttribute('aria-busy')).toBe('true'));
		expect(screen.getAllByRole('button', { name: 'Test model' })[0]).toBe(testButton);

		resolveTest({ success: true, target: 'chatTitle', durationMs: 10 });
		await screen.findByText('Model responded in 10 ms.');
	});

	it('persists title and commit effort as independent generation settings', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				ui: {
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus', thinkingMode: 'none' },
					commitMessage: { agentId: 'codex', model: 'gpt-5.4', thinkingMode: 'low' },
				},
				uiEffective: {
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus', thinkingMode: 'none' },
					commitMessage: { agentId: 'codex', model: 'gpt-5.4', thinkingMode: 'low' },
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);
		render(RemoteSettingsSectionTestHost);

		await fireEvent.click(
			screen.getAllByRole('button', { name: /Claude .* Opus .* Default/ })[0],
		);
		await fireEvent.click(await screen.findByRole('button', { name: /High Thorough reasoning/ }));
		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: {
					chatTitle: expect.objectContaining({ thinkingMode: 'high' }),
				},
			});
		});

		vi.mocked(updateRemoteSettings).mockClear();
		await fireEvent.click(screen.getByRole('button', { name: /Codex .* GPT-5.4 .* Low/ }));
		await fireEvent.click(
			await screen.findByRole('button', { name: /Ultra Highest available reasoning effort/ }),
		);
		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: {
					commitMessage: expect.objectContaining({ thinkingMode: 'ultra' }),
				},
			});
		});
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
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus', thinkingMode: 'none' },
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						thinkingMode: 'none',
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

	it('edits the commit generation prompt transactionally in a dialog', async () => {
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
					chatTitle: { enabled: true, agentId: 'claude', model: 'opus', thinkingMode: 'none' },
					commitMessage: {
						agentId: 'codex',
						model: 'gpt-5.4',
						thinkingMode: 'none',
						customPrompt: '',
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);

		render(RemoteSettingsSectionTestHost);

		const [editCommitPrompt] = screen.getAllByRole('button', {
			name: 'Edit generation prompt',
		});
		await fireEvent.click(editCommitPrompt);

		const prompt = screen.getByRole('textbox', { name: 'Edit commit generation prompt' });
		expect((prompt as HTMLTextAreaElement).value).toBe(DEFAULT_COMMIT_MESSAGE_PROMPT);
		expect(screen.getByText('{{files}}')).toBeTruthy();
		expect(screen.getByText('{{diff}}')).toBeTruthy();
		expect(
			(screen.getByRole('button', { name: 'Restore default' }) as HTMLButtonElement).disabled,
		).toBe(true);

		await fireEvent.input(prompt, {
			target: { value: 'Summarize {{files}} with {{diff}}' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: {
					commitMessage: expect.objectContaining({
						customPrompt: 'Summarize {{files}} with {{diff}}',
					}),
				},
			});
		});
		await waitFor(() => {
			expect(screen.queryByRole('dialog')).toBeNull();
		});

		await fireEvent.click(editCommitPrompt);
		expect(
			(screen.getByRole('textbox', {
				name: 'Edit commit generation prompt',
			}) as HTMLTextAreaElement).value,
		).toBe('Summarize {{files}} with {{diff}}');
		vi.mocked(updateRemoteSettings).mockClear();

		const reopenedPrompt = screen.getByRole('textbox', {
			name: 'Edit commit generation prompt',
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Restore default' }));
		expect((reopenedPrompt as HTMLTextAreaElement).value).toBe(DEFAULT_COMMIT_MESSAGE_PROMPT);
		expect(updateRemoteSettings).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(updateRemoteSettings).not.toHaveBeenCalled();
	});

	it('validates and persists prompt-refinement instructions', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				ui: {
					promptRefinement: {
						agentId: 'claude',
						model: 'opus',
						customPrompt: '',
					},
				},
				uiEffective: {
					promptRefinement: {
						agentId: 'claude',
						model: 'opus',
						thinkingMode: 'none',
						customPrompt: '',
					},
				},
			}),
		);
		setTestRemoteSettingsStore(store);
		mockRemoteSettingsUpdate(store);
		render(RemoteSettingsSectionTestHost);

		const [, editRefinementPrompt] = screen.getAllByRole('button', {
			name: 'Edit generation prompt',
		});
		await fireEvent.click(editRefinementPrompt);
		const prompt = screen.getByRole('textbox', {
			name: 'Edit prompt refinement instructions',
		});
		expect((prompt as HTMLTextAreaElement).value).toBe(DEFAULT_PROMPT_REFINEMENT_PROMPT);
		expect(screen.getByText('{{USER_PROMPT}}')).toBeTruthy();

		await fireEvent.input(prompt, { target: { value: 'Rewrite this draft.' } });
		expect(
			screen.getByText('The generation prompt must include {{USER_PROMPT}}.'),
		).toBeTruthy();
		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
			true,
		);

		await fireEvent.input(prompt, {
			target: { value: 'x'.repeat(GENERATION_PROMPT_TEMPLATE_MAX_LENGTH + 1) },
		});
		expect(
			screen.getByText('The generation prompt cannot exceed 32000 characters.'),
		).toBeTruthy();

		await fireEvent.input(prompt, { target: { value: 'Rewrite: {{USER_PROMPT}}' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => {
			expect(updateRemoteSettings).toHaveBeenCalledWith({
				ui: {
					promptRefinement: expect.objectContaining({
						customPrompt: 'Rewrite: {{USER_PROMPT}}',
					}),
				},
			});
		});
	});

	it('keeps a failed prompt save in the dialog for retry', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		vi.mocked(updateRemoteSettings).mockRejectedValueOnce(new Error('Settings are unavailable.'));
		render(RemoteSettingsSectionTestHost);

		const [editCommitPrompt] = screen.getAllByRole('button', {
			name: 'Edit generation prompt',
		});
		await fireEvent.click(editCommitPrompt);
		const prompt = screen.getByRole('textbox', { name: 'Edit commit generation prompt' });
		await fireEvent.input(prompt, { target: { value: 'Keep this private draft.' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(await screen.findByText('Settings are unavailable.')).toBeTruthy();
		expect((prompt as HTMLTextAreaElement).value).toBe('Keep this private draft.');
		expect(screen.getByRole('dialog')).toBeTruthy();
	});

	it('keeps the generation prompt dialog open when Escape is pressed during save', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(makeSnapshot());
		setTestRemoteSettingsStore(store);
		let rejectUpdate!: (reason?: unknown) => void;
		const updatePromise = new Promise<Awaited<ReturnType<typeof updateRemoteSettings>>>(
			(_resolve, reject) => {
				rejectUpdate = reject;
			},
		);
		vi.mocked(updateRemoteSettings).mockReturnValueOnce(updatePromise);
		render(RemoteSettingsSectionTestHost);

		const [editCommitPrompt] = screen.getAllByRole('button', {
			name: 'Edit generation prompt',
		});
		await fireEvent.click(editCommitPrompt);
		const prompt = screen.getByRole('textbox', { name: 'Edit commit generation prompt' });
		await fireEvent.input(prompt, { target: { value: 'Keep this private draft.' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		const dialog = screen.getByRole('dialog');
		await screen.findByRole('button', { name: 'Saving...' });
		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect(dialog.isConnected).toBe(true);

		rejectUpdate(new Error('Settings are unavailable.'));
		expect(await screen.findByText('Settings are unavailable.')).toBeTruthy();
		expect((prompt as HTMLTextAreaElement).value).toBe('Keep this private draft.');
		expect(screen.getByRole('dialog')).toBe(dialog);
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
