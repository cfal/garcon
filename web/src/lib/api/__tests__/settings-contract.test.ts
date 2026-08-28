import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	beginTelegramRecipientLink,
	clearTelegramBotToken,
	clearTelegramRecipient,
	getRemoteSettings,
	resolveTelegramRecipientLink,
	saveTelegramBotToken,
	sendTelegramTest,
	testTelegramBotToken,
	testGenerationModel,
	updateRemoteSettings,
} from '../settings';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

function makeSnapshot(overrides?: Record<string, unknown>) {
	return {
		version: 1,
		features: { transcriptSearch: { enabled: false } },
		ui: { pinnedInsertPosition: 'top' },
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [],
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
		...overrides,
	};
}

describe('settings API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	function jsonResponse(body: unknown, status = 200) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('getRemoteSettings calls GET /api/v1/app/settings', async () => {
		const payload = makeSnapshot();
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getRemoteSettings();
		expect(result).toEqual(payload);

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/settings');
		expect(opts.method ?? 'GET').toBe('GET');
	});

	it('updateRemoteSettings sends PUT and returns canonical snapshot', async () => {
		const snapshot = makeSnapshot({ ui: { pinnedInsertPosition: 'bottom' } });
		const payload = { success: true, settings: snapshot };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await updateRemoteSettings({ ui: { pinnedInsertPosition: 'bottom' } });
		expect(result).toEqual(payload);

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/settings');
		expect(opts.method).toBe('PUT');
		expect(JSON.parse(opts.body)).toEqual({ ui: { pinnedInsertPosition: 'bottom' } });
	});

	it('tests only the saved generation target through the long-running endpoint', async () => {
		const payload = { success: true as const, target: 'chatTitle' as const, durationMs: 8_432 };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		await expect(testGenerationModel('chatTitle', 'saved-config-key')).resolves.toEqual(payload);

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/generation/test');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({
			target: 'chatTitle',
			configurationKey: 'saved-config-key',
		});
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});

	it('preserves app title settings in remote settings payloads', async () => {
		const payload = makeSnapshot({
			ui: {
				appIdentity: {
					title: 'Garcon - Work',
				},
			},
		});
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getRemoteSettings();

		expect(result.ui.appIdentity).toEqual({ title: 'Garcon - Work' });
	});

	it('normalizes persisted and effective generation effort independently', async () => {
		const payload = makeSnapshot({
			ui: {
				chatTitle: { thinkingMode: 'max' },
				commitMessage: { thinkingMode: 'ultra' },
			},
			uiEffective: {
				chatTitle: {
					enabled: true,
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'max',
				},
				commitMessage: {
					agentId: 'codex',
					model: 'gpt-5.5',
					thinkingMode: 'ultra',
				},
			},
		});
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getRemoteSettings();

		expect(result.ui.chatTitle?.thinkingMode).toBe('max');
		expect(result.ui.commitMessage?.thinkingMode).toBe('ultra');
		expect(result.uiEffective.chatTitle?.thinkingMode).toBe('max');
		expect(result.uiEffective.commitMessage?.thinkingMode).toBe('ultra');
	});

	it('drops invalid persisted effort and defaults invalid effective effort', async () => {
		const payload = makeSnapshot({
			ui: {
				chatTitle: { thinkingMode: 'impossible' },
			},
			uiEffective: {
				chatTitle: {
					enabled: true,
					agentId: 'claude',
					model: 'opus',
					thinkingMode: 'impossible',
				},
			},
		});
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getRemoteSettings();

		expect(result.ui.chatTitle?.thinkingMode).toBeUndefined();
		expect(result.uiEffective.chatTitle?.thinkingMode).toBe('none');
	});

	it('drops malformed app title settings from remote settings payloads', async () => {
		const payload = makeSnapshot({
			ui: {
				pinnedInsertPosition: 'bottom',
				appIdentity: {
					title: '   ',
				},
			},
		});
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getRemoteSettings();

		expect(result.ui.pinnedInsertPosition).toBe('bottom');
		expect(result.ui.appIdentity).toBeUndefined();
	});

	it('sends app title settings through updateRemoteSettings', async () => {
		const snapshot = makeSnapshot({
			ui: {
				appIdentity: {
					title: 'Garcon - Work',
				},
			},
		});
		const payload = { success: true, settings: snapshot };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await updateRemoteSettings({
			ui: { appIdentity: { title: 'Garcon - Work' } },
		});

		expect(result.settings.ui.appIdentity).toEqual({ title: 'Garcon - Work' });
		const [_url, opts] = fetchMock.mock.calls[0];
		expect(JSON.parse(opts.body)).toEqual({
			ui: { appIdentity: { title: 'Garcon - Work' } },
		});
	});

	it('rejects malformed GET settings payloads', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ version: 'oops' }));

		await expect(getRemoteSettings()).rejects.toThrow('Invalid remote settings response');
	});

	it('drops raw Telegram bot tokens from remote settings payloads', async () => {
		const payload = makeSnapshot({
			ui: {
				notifications: {
					telegram: {
						enabled: true,
						chatId: '123',
						botToken: 'secret-token',
					},
				},
			},
		});
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getRemoteSettings();
		const telegram = result.ui.notifications?.telegram as Record<string, unknown>;

		expect(telegram.enabled).toBe(true);
		expect(telegram.chatId).toBeUndefined();
		expect(telegram.botToken).toBeUndefined();
	});

	it('rejects malformed PUT settings payloads', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, settings: { version: 'oops' } }));

		await expect(updateRemoteSettings({ ui: { pinnedInsertPosition: 'bottom' } })).rejects.toThrow(
			'Invalid remote settings update response',
		);
	});

	it('saves Telegram bot token without expecting the token in the response', async () => {
		const snapshot = makeSnapshot({
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
		});
		fetchMock.mockResolvedValue(jsonResponse({ success: true, settings: snapshot }));

		const result = await saveTelegramBotToken('secret-token');

		expect(result.settings.telegram.botTokenAvailable).toBe(true);
		expect(result.settings.telegram.linkUrl).toBe('https://t.me/garcon_bot?start=abc');
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/telegram/token');
		expect(opts.method).toBe('PUT');
		expect(JSON.parse(opts.body)).toEqual({ botToken: 'secret-token' });
	});

	it('clears Telegram bot token and returns the canonical settings snapshot', async () => {
		const snapshot = makeSnapshot();
		fetchMock.mockResolvedValue(jsonResponse({ success: true, settings: snapshot }));

		const result = await clearTelegramBotToken();

		expect(result.settings.telegram.botTokenAvailable).toBe(false);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/telegram/token');
		expect(opts.method).toBe('DELETE');
	});

	it('tests a Telegram token through the token test endpoint', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				success: true,
				bot: { id: 123, username: 'garcon_bot', firstName: 'Garcon' },
			}),
		);

		const result = await testTelegramBotToken('secret-token');

		expect(result.bot.username).toBe('garcon_bot');
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/telegram/token/test');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({ botToken: 'secret-token' });
	});

	it('creates and resolves a Telegram recipient link', async () => {
		const pending = makeSnapshot({
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
		});
		const linked = makeSnapshot({
			telegram: {
				...pending.telegram,
				recipientUsername: 'alice',
				recipientDisplayName: 'Alice',
				recipientLinked: true,
				pendingLink: false,
				linkUrl: null,
			},
		});
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({ success: true, linkUrl: pending.telegram.linkUrl, settings: pending }),
			)
			.mockResolvedValueOnce(jsonResponse({ success: true, settings: linked }));

		const link = await beginTelegramRecipientLink();
		const resolved = await resolveTelegramRecipientLink();

		expect(link.linkUrl).toBe('https://t.me/garcon_bot?start=abc');
		expect(resolved.settings.telegram.recipientLinked).toBe(true);
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/app/telegram/recipient/link');
		expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/app/telegram/recipient/resolve');
	});

	it('clears Telegram recipient and sends test messages to the linked recipient', async () => {
		const snapshot = makeSnapshot();
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ success: true, settings: snapshot }))
			.mockResolvedValueOnce(jsonResponse({ success: true }));

		await clearTelegramRecipient();
		await sendTelegramTest();

		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/app/telegram/recipient');
		expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
		expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/app/telegram/test');
		expect(fetchMock.mock.calls[1][1].method).toBe('POST');
	});
});
