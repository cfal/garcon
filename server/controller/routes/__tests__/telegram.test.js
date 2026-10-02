import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { makeRequest, createWorkspaceFixture, remoteSettingsSource } from './workspace-route-fixture.js';
import createWorkspaceRoutes from '../workspace.js';
import { CorruptStateFileError } from '../../../common/json-file-store.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TelegramSettingsStore } from '../../notifications/telegram-settings-store.js';

let ctx;
beforeEach(() => {
  ctx = createWorkspaceFixture();
});

describe('Telegram token settings API', () => {
  function createTelegramRoutes() {
    const publicStatus = {
      botTokenAvailable: false,
      botUsername: null,
      botFirstName: null,
      recipientUsername: null,
      recipientDisplayName: null,
      recipientLinked: false,
      pendingLink: false,
      linkUrl: null,
    };
    const telegramNotifier = {
      isConfigured: false,
      getBotIdentity: mock(() => Promise.resolve({ id: 123, username: 'garcon_bot', firstName: 'Garcon' })),
      resolveRecipientLink: mock(() => Promise.resolve({
        recipient: {
          chatId: '99999',
          username: 'alice',
          displayName: 'Alice',
          nextOffset: 12,
        },
        nextOffset: 12,
      })),
      setBotToken: mock((botToken) => {
        telegramNotifier.isConfigured = Boolean(botToken);
      }),
      send: mock(() => Promise.resolve(true)),
    };
    const telegramSettings = {
      getBotToken: mock(() => 'secret-token'),
      getRecipientChatId: mock(() => publicStatus.recipientLinked ? '99999' : ''),
      getPendingRecipientLink: mock(() => ({ botToken: 'secret-token', botId: 123, linkCode: 'abc123', offset: null })),
      getPublicStatus: mock(() => publicStatus),
      setBotToken: mock((botToken, identity) => {
        publicStatus.botTokenAvailable = Boolean(botToken);
        publicStatus.botUsername = identity.username;
        publicStatus.botFirstName = identity.firstName;
        return Promise.resolve(undefined);
      }),
      clearBotToken: mock(() => {
        publicStatus.botTokenAvailable = false;
        publicStatus.botUsername = null;
        publicStatus.botFirstName = null;
        publicStatus.recipientUsername = null;
        publicStatus.recipientDisplayName = null;
        publicStatus.recipientLinked = false;
        publicStatus.pendingLink = false;
        publicStatus.linkUrl = null;
        return Promise.resolve(undefined);
      }),
      beginRecipientLink: mock(() => {
        publicStatus.pendingLink = true;
        publicStatus.linkUrl = 'https://t.me/garcon_bot?start=abc123';
        return Promise.resolve(publicStatus.linkUrl);
      }),
      applyRecipientLinkResult: mock((_expected, { recipient }) => {
        publicStatus.recipientLinked = true;
        publicStatus.recipientUsername = recipient.username;
        publicStatus.recipientDisplayName = recipient.displayName;
        publicStatus.pendingLink = false;
        publicStatus.linkUrl = null;
        return Promise.resolve(true);
      }),
      clearRecipient: mock(() => {
        publicStatus.recipientLinked = false;
        publicStatus.recipientUsername = null;
        publicStatus.recipientDisplayName = null;
        publicStatus.pendingLink = false;
        publicStatus.linkUrl = null;
        return Promise.resolve(undefined);
      }),
    };
    const routes = createWorkspaceRoutes(ctx.settings, ctx.agents, telegramNotifier, telegramSettings, '/worker/projects');
    return { routes, telegramNotifier, telegramSettings, publicStatus };
  }

  it('stores the bot token server-side and returns only token availability', async () => {
    const { routes, telegramNotifier, telegramSettings } = createTelegramRoutes();
    const requestBody = { botToken: '  secret-token  ' };

    const response = await routes['/api/v1/app/telegram/token'].PUT(
      makeRequest('http://localhost/api/app/telegram/token', 'PUT', requestBody),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.settings.telegram.botTokenAvailable).toBe(true);
    expect(body.settings.telegram.botUsername).toBe('garcon_bot');
    expect(body.settings.telegram.pendingLink).toBe(true);
    expect(body.settings.telegram.linkUrl).toBe('https://t.me/garcon_bot?start=abc123');
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(telegramNotifier.getBotIdentity).toHaveBeenCalledWith('secret-token');
    expect(telegramSettings.setBotToken).toHaveBeenCalledWith(
      'secret-token',
      { id: 123, username: 'garcon_bot', firstName: 'Garcon' },
    );
    expect(telegramNotifier.setBotToken).toHaveBeenCalledWith('secret-token');
    expect(telegramSettings.beginRecipientLink).toHaveBeenCalledWith();
  });

  it('does not store the bot token when Telegram validation fails', async () => {
    const { routes, telegramNotifier, telegramSettings } = createTelegramRoutes();
    telegramNotifier.getBotIdentity.mockImplementationOnce(() => Promise.reject(new Error('Unauthorized')));
    const requestBody = { botToken: 'bad-token' };

    const response = await routes['/api/v1/app/telegram/token'].PUT(
      makeRequest('http://localhost/api/app/telegram/token', 'PUT', requestBody),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('telegram_token_test_failed');
    expect(body.details).toBe('Unauthorized');
    expect(telegramSettings.setBotToken).not.toHaveBeenCalled();
    expect(telegramSettings.beginRecipientLink).not.toHaveBeenCalled();
    expect(telegramNotifier.setBotToken).not.toHaveBeenCalled();
  });

  it('clears the bot token and returns unavailable status', async () => {
    const { routes, telegramNotifier, telegramSettings } = createTelegramRoutes();
    let uiSettings = { notifications: { telegram: { enabled: true } } };
    telegramNotifier.isConfigured = true;
    ctx.settings.getUiSettings.mockImplementation(() => uiSettings);
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({ ui: uiSettings }));
    ctx.settings.setUiSettings.mockImplementation((patch) => {
      uiSettings = { ...uiSettings, ...patch };
      return Promise.resolve(uiSettings);
    });

    const response = await routes['/api/v1/app/telegram/token'].DELETE();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.settings.telegram.botTokenAvailable).toBe(false);
    expect(body.settings.ui.notifications.telegram.enabled).toBe(false);
    expect(telegramSettings.clearBotToken).toHaveBeenCalled();
    expect(telegramNotifier.setBotToken).toHaveBeenCalledWith('');
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      notifications: { telegram: { enabled: false } },
    });
  });

  it('tests a typed Telegram token without saving it', async () => {
    const { routes, telegramNotifier, telegramSettings } = createTelegramRoutes();
    const requestBody = { botToken: 'typed-token' };

    const response = await routes['/api/v1/app/telegram/token/test'].POST(
      makeRequest('http://localhost/api/app/telegram/token/test', 'POST', requestBody),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bot.username).toBe('garcon_bot');
    expect(telegramNotifier.getBotIdentity).toHaveBeenCalledWith('typed-token');
    expect(telegramSettings.setBotToken).not.toHaveBeenCalled();
  });

  it('creates and resolves a Telegram recipient link', async () => {
    const { routes, telegramSettings, telegramNotifier } = createTelegramRoutes();

    const linkResponse = await routes['/api/v1/app/telegram/recipient/link'].POST(
      makeRequest('http://localhost/api/app/telegram/recipient/link', 'POST', {}),
    );
    const linkBody = await linkResponse.json();

    expect(linkResponse.status).toBe(200);
    expect(linkBody.linkUrl).toBe('https://t.me/garcon_bot?start=abc123');
    expect(linkBody.settings.telegram.pendingLink).toBe(true);
    expect(telegramSettings.beginRecipientLink).toHaveBeenCalledWith();

    const resolveResponse = await routes['/api/v1/app/telegram/recipient/resolve'].POST();
    const resolveBody = await resolveResponse.json();

    expect(resolveResponse.status).toBe(200);
    expect(resolveBody.settings.telegram.recipientLinked).toBe(true);
    expect(telegramNotifier.resolveRecipientLink).toHaveBeenCalledWith('abc123', null, 20);
    expect(telegramSettings.applyRecipientLinkResult).toHaveBeenCalledWith(
      { botToken: 'secret-token', botId: 123, linkCode: 'abc123', offset: null },
      { recipient: { chatId: '99999', username: 'alice', displayName: 'Alice', nextOffset: 12 }, nextOffset: 12 },
    );
  });

  it('reports corrupt Telegram state as an opaque server error', async () => {
    const { routes, telegramSettings } = createTelegramRoutes();
    telegramSettings.beginRecipientLink.mockRejectedValueOnce(new CorruptStateFileError(
      '/server/config/notifications.json',
      '/server/config/notifications.json.corrupt-test',
    ));

    const response = await routes['/api/v1/app/telegram/recipient/link'].POST(
      makeRequest('http://localhost/api/app/telegram/recipient/link', 'POST', {}),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
    });
  });

  it('keeps corrupt Telegram state opaque during token mutations', async () => {
    const corrupt = () => new CorruptStateFileError(
      '/server/config/notifications.json',
      '/server/config/notifications.json.corrupt-test',
    );
    const expected = {
      success: false,
      error: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
    };

    let fixture = createTelegramRoutes();
    fixture.telegramSettings.setBotToken.mockRejectedValueOnce(corrupt());
    const requestBody = { botToken: 'secret-token' };
    let response = await fixture.routes['/api/v1/app/telegram/token'].PUT(
      makeRequest('http://localhost/api/app/telegram/token', 'PUT', requestBody),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(expected);

    fixture = createTelegramRoutes();
    fixture.telegramSettings.clearBotToken.mockRejectedValueOnce(corrupt());
    response = await fixture.routes['/api/v1/app/telegram/token'].DELETE();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(expected);
  });

  it('sends test notification to the linked recipient only', async () => {
    const { routes, publicStatus, telegramNotifier } = createTelegramRoutes();

    let response = await routes['/api/v1/app/telegram/test'].POST(
      makeRequest('http://localhost/api/app/telegram/test', 'POST', {}),
    );
    expect(response.status).toBe(400);

    telegramNotifier.isConfigured = true;
    publicStatus.recipientLinked = true;
    response = await routes['/api/v1/app/telegram/test'].POST(
      makeRequest('http://localhost/api/app/telegram/test', 'POST', {}),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(telegramNotifier.send).toHaveBeenCalledWith(
      '99999',
      'Garcon: test notification. Your Telegram integration is working.',
    );
  });

  it.each(['delivery', 'unexpected'])('returns a coded %s notification failure', async (failure) => {
    const { routes, publicStatus, telegramNotifier } = createTelegramRoutes();
    telegramNotifier.isConfigured = true;
    publicStatus.recipientLinked = true;
    if (failure === 'delivery') telegramNotifier.send.mockResolvedValueOnce(false);
    else telegramNotifier.send.mockRejectedValueOnce(new Error('/private/synthetic-secret'));
    const response = await routes['/api/v1/app/telegram/test'].POST();
    expect(response.status).toBe(failure === 'delivery' ? 502 : 500);
    const body = await response.json();
    expect(body).toEqual(failure === 'delivery' ? {
      success: false, error: 'Telegram delivery failed. Check your bot token and linked recipient.',
      errorCode: 'telegram_delivery_failed', retryable: false,
    } : {
      success: false, error: 'Internal server error', errorCode: 'INTERNAL_ERROR', retryable: true,
    });
  });
});

describe('Telegram recipient publication fences', () => {
  for (const mutation of ['clear recipient', 'replace link', 'rotate token', 'clear token']) {
    it(`rejects a deferred poll after ${mutation}`, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-telegram-race-'));
      try {
        const filePath = path.join(directory, 'notifications.json');
        const store = new TelegramSettingsStore(filePath);
        await store.init();
        const identity = { id: 123, username: 'garcon_bot', firstName: 'Garcon' };
        await store.setBotToken('initial-token', identity);
        await store.beginRecipientLink();
        const poll = Promise.withResolvers();
        const started = Promise.withResolvers();
        const notifier = { resolveRecipientLink: () => { started.resolve(); return poll.promise; } };
        const routes = createWorkspaceRoutes(ctx.settings, ctx.agents, notifier, store, '/worker/projects');
        const resolving = routes['/api/v1/app/telegram/recipient/resolve'].POST();
        await started.promise;
        if (mutation === 'clear recipient') await store.clearRecipient();
        else if (mutation === 'replace link') await store.beginRecipientLink();
        else if (mutation === 'rotate token') await store.setBotToken('new-token', identity);
        else await store.clearBotToken();
        const persisted = await fs.readFile(filePath, 'utf8');
        poll.resolve({ nextOffset: 100, recipient: { chatId: 'stale', username: 'stale', displayName: 'Stale', nextOffset: 100 } });
        const response = await resolving;
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ success: false, errorCode: 'telegram_link_changed', retryable: false });
        expect(store.getPublicStatus().recipientLinked).toBe(false);
        expect(await fs.readFile(filePath, 'utf8')).toBe(persisted);
        if (mutation === 'clear recipient') {
          await store.beginRecipientLink();
          expect(await store.applyRecipientLinkResult(store.getPendingRecipientLink(), {
            nextOffset: 101, recipient: { chatId: 'fresh', username: null, displayName: null, nextOffset: 101 },
          })).toBe(true);
          expect(store.getRecipientChatId()).toBe('fresh');
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
});
