import { describe, it, expect, beforeEach, mock } from 'bun:test';

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => undefined),
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => '/home'),
}));

import createWorkspaceRoutes from '../workspace.js';
import { parseJsonBody } from '../../lib/http-request.js';

function createMockCtx() {
  return {
    settings: {
      setSessionName: mock(() => Promise.resolve(undefined)),
      getRemoteSettingsVersion: mock(() => Promise.resolve(0)),
      getUiSettings: mock(() => Promise.resolve({})),
      setUiSettings: mock(() => Promise.resolve({})),
      getPathSettings: mock(() => Promise.resolve({})),
      setPathSettings: mock(() => Promise.resolve({})),
      getPinnedChatIds: mock(() => Promise.resolve([])),
      getLastAgentId: mock(() => Promise.resolve('claude')),
      getLastProjectPath: mock(() => Promise.resolve('')),
      getLastModel: mock(() => Promise.resolve('')),
      getLastPermissionMode: mock(() => Promise.resolve('default')),
      getLastThinkingMode: mock(() => Promise.resolve('none')),
      getLastClaudeThinkingMode: mock(() => Promise.resolve('auto')),
      getLastAmpAgentMode: mock(() => Promise.resolve('smart')),
      getFolders: mock(() => Promise.resolve([])),
      addFolder: mock(() => Promise.resolve(undefined)),
      updateFolder: mock(() => Promise.resolve(undefined)),
      removeFolder: mock(() => Promise.resolve(false)),
      getSavedSearches: mock(() => Promise.resolve([])),
      addSavedSearch: mock(() => Promise.resolve(undefined)),
      updateSavedSearch: mock(() => Promise.resolve(undefined)),
      removeSavedSearch: mock(() => Promise.resolve(false)),
      reorderSavedSearches: mock(() => Promise.resolve({ success: true })),
    },
    agents: {
      getAgentAuthStatusMap: mock(() => Promise.resolve({
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
      })),
      getModels: mock(() => Promise.resolve([])),
    },
  };
}

const ctx = createMockCtx();
const appRoutes = createWorkspaceRoutes(ctx.settings, ctx.agents);

function makeRequest(url, method, body) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/app/session-name', () => {
  const handler = appRoutes['/api/v1/app/session-name'].PUT;

  beforeEach(() => {
    ctx.settings.setSessionName.mockClear();
    ctx.settings.getUiSettings.mockClear();
    ctx.settings.setUiSettings.mockClear();
    ctx.settings.getPathSettings.mockClear();
    ctx.settings.setPathSettings.mockClear();
    ctx.settings.getRemoteSettingsVersion.mockClear();
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastAgentId.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.agents.getAgentAuthStatusMap.mockClear();
    ctx.agents.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('sets a session name with valid payload', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: '123', title: 'My Chat' }));

    const response = await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', { chatId: '123', title: 'My Chat' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.setSessionName).toHaveBeenCalledWith('123', 'My Chat');
  });

  it('returns 400 when chatId is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ title: 'My Chat' }));

    const response = await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', { title: 'My Chat' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('chatId is required');
  });

  it('returns 400 when title is empty', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: '123', title: '' }));

    const response = await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', { chatId: '123', title: '' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('title is required');
  });

  it('returns 400 when title is whitespace-only', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: '123', title: '   ' }));

    const response = await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', { chatId: '123', title: '   ' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('title is required');
  });

  it('trims the title before saving', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: '123', title: '  Trimmed  ' }));

    await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', { chatId: '123', title: '  Trimmed  ' }));

    expect(ctx.settings.setSessionName).toHaveBeenCalledWith('123', 'Trimmed');
  });
});

describe('GET /api/app/settings', () => {
  const handler = appRoutes['/api/v1/app/settings'].GET;

  beforeEach(() => {
    ctx.settings.setSessionName.mockClear();
    ctx.settings.getUiSettings.mockClear();
    ctx.settings.setUiSettings.mockClear();
    ctx.settings.getPathSettings.mockClear();
    ctx.settings.setPathSettings.mockClear();
    ctx.settings.getRemoteSettingsVersion.mockClear();
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastAgentId.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.agents.getAgentAuthStatusMap.mockClear();
    ctx.agents.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('returns ui, paths, pinnedChatIds, and recent startup settings', async () => {
    ctx.settings.getRemoteSettingsVersion.mockImplementation(() => Promise.resolve(7));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({ theme: 'dark' }));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({ pinnedProjectPaths: ['/home'], browseStartPath: '/workspace' }));
    ctx.settings.getPinnedChatIds.mockImplementation(() => Promise.resolve(['a', 'b']));
    ctx.settings.getLastAgentId.mockImplementation(() => Promise.resolve('codex'));
    ctx.settings.getLastProjectPath.mockImplementation(() => Promise.resolve('/workspace/project'));
    ctx.settings.getLastModel.mockImplementation(() => Promise.resolve('gpt-5.4'));
    ctx.settings.getLastPermissionMode.mockImplementation(() => Promise.resolve('acceptEdits'));
    ctx.settings.getLastThinkingMode.mockImplementation(() => Promise.resolve('think-hard'));
    ctx.settings.getLastClaudeThinkingMode.mockImplementation(() => Promise.resolve('on'));

    const response = await handler();
    const body = await response.json();

    expect(body.version).toBe(7);
    expect(body.ui).toEqual({ theme: 'dark' });
    expect(body.paths).toEqual({ pinnedProjectPaths: ['/home'], browseStartPath: '/workspace' });
    expect(body.pinnedChatIds).toEqual(['a', 'b']);
    expect(body.lastAgentId).toBe('codex');
    expect(body.lastProjectPath).toBe('/workspace/project');
    expect(body.lastModel).toBe('gpt-5.4');
    expect(body.lastApiProviderId).toBeNull();
    expect(body.lastModelEndpointId).toBeNull();
    expect(body.lastModelProtocol).toBeNull();
    expect(body.lastPermissionMode).toBe('acceptEdits');
    expect(body.lastThinkingMode).toBe('think-hard');
    expect(body.lastClaudeThinkingMode).toBe('on');
    expect(body.uiEffective.chatTitle.enabled).toBe(false);
    expect(body.uiEffective.chatTitle.agentId).toBe('claude');
    expect(body.uiEffective.chatTitle.model).toBe('haiku');
    expect(body.uiEffective.commitMessage.enabled).toBe(false);
    expect(body.uiEffective.commitMessage.agentId).toBe('claude');
    expect(body.uiEffective.commitMessage.model).toBe('haiku');
    expect(body.chatSortOrder).toBeUndefined();
  });

  it('auto-enables generation defaults from authenticated agent priority', async () => {
    ctx.settings.getRemoteSettingsVersion.mockImplementation(() => Promise.resolve(1));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.agents.getAgentAuthStatusMap.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: true },
      opencode: { authenticated: true },
    }));
    ctx.agents.getModels.mockImplementation(() => Promise.resolve([
      { value: 'deepseek-r1', label: 'DeepSeek R1' },
      { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
    ]));

    const response = await handler();
    const body = await response.json();

    expect(body.version).toBe(1);
    expect(body.uiEffective.chatTitle.enabled).toBe(true);
    expect(body.uiEffective.chatTitle.agentId).toBe('codex');
    expect(body.uiEffective.chatTitle.model).toBe('gpt-5.5');
    expect(body.uiEffective.commitMessage.enabled).toBe(true);
    expect(body.uiEffective.commitMessage.agentId).toBe('codex');
    expect(body.uiEffective.commitMessage.model).toBe('gpt-5.5');
  });

  it('preserves persisted commitMessage extra fields in uiEffective', async () => {
    ctx.settings.getRemoteSettingsVersion.mockImplementation(() => Promise.resolve(3));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({
      commitMessage: {
        enabled: true,
        agentId: 'codex',
        model: 'gpt-5.5',
        customPrompt: 'Write a short message',
        useCommonDirPrefix: true,
      },
    }));

    const response = await handler();
    const body = await response.json();

    expect(body.version).toBe(3);
    expect(body.uiEffective.commitMessage.enabled).toBe(true);
    expect(body.uiEffective.commitMessage.agentId).toBe('codex');
    expect(body.uiEffective.commitMessage.model).toBe('gpt-5.5');
    expect(body.uiEffective.commitMessage.customPrompt).toBe('Write a short message');
    expect(body.uiEffective.commitMessage.useCommonDirPrefix).toBe(true);
  });
});

describe('PUT /api/app/settings', () => {
  const handler = appRoutes['/api/v1/app/settings'].PUT;

  beforeEach(() => {
    ctx.settings.setSessionName.mockClear();
    ctx.settings.getUiSettings.mockClear();
    ctx.settings.setUiSettings.mockClear();
    ctx.settings.getPathSettings.mockClear();
    ctx.settings.setPathSettings.mockClear();
    ctx.settings.getRemoteSettingsVersion.mockClear();
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastAgentId.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.agents.getAgentAuthStatusMap.mockClear();
    ctx.agents.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('patches ui settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ ui: { fontSize: 14 } }));
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({ fontSize: 14 }));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { ui: { fontSize: 14 } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ fontSize: 14 });
  });

  it('patches paths settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ paths: { lastDir: '/tmp' } }));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.settings.setPathSettings.mockImplementation(() => Promise.resolve({ lastDir: '/tmp' }));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { paths: { lastDir: '/tmp' } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setPathSettings).toHaveBeenCalledWith({ lastDir: '/tmp' });
  });

  it('patches ui.chatTitle settings', async () => {
    const chatTitleConfig = { enabled: true, agentId: 'opencode', model: 'anthropic/claude-sonnet-4-5' };
    parseJsonBody.mockImplementation(() => Promise.resolve({ ui: { chatTitle: chatTitleConfig } }));
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({ chatTitle: chatTitleConfig }));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { ui: { chatTitle: chatTitleConfig } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ chatTitle: chatTitleConfig });
  });

  it('does not patch last startup settings through app settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ lastPermissionMode: 'acceptEdits', lastThinkingMode: 'think-hard', lastClaudeThinkingMode: 'off' }));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { lastPermissionMode: 'acceptEdits', lastThinkingMode: 'think-hard', lastClaudeThinkingMode: 'off' }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.lastPermissionMode).toBeUndefined();
    expect(body.lastThinkingMode).toBeUndefined();
    expect(body.lastClaudeThinkingMode).toBeUndefined();
  });
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
      getPendingLinkCode: mock(() => 'abc123'),
      getUpdateOffset: mock(() => null),
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
      setUpdateOffset: mock(() => Promise.resolve(undefined)),
      completeRecipientLink: mock((recipient) => {
        publicStatus.recipientLinked = true;
        publicStatus.recipientUsername = recipient.username;
        publicStatus.recipientDisplayName = recipient.displayName;
        publicStatus.pendingLink = false;
        publicStatus.linkUrl = null;
        return Promise.resolve(undefined);
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
    const routes = createWorkspaceRoutes(ctx.settings, ctx.agents, telegramNotifier, telegramSettings);
    return { routes, telegramNotifier, telegramSettings, publicStatus };
  }

  beforeEach(() => {
    ctx.settings.getUiSettings.mockClear();
    ctx.settings.getPathSettings.mockClear();
    ctx.settings.getRemoteSettingsVersion.mockClear();
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastAgentId.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.agents.getAgentAuthStatusMap.mockClear();
    ctx.agents.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('stores the bot token server-side and returns only token availability', async () => {
    const { routes, telegramNotifier, telegramSettings } = createTelegramRoutes();
    parseJsonBody.mockImplementation(() => Promise.resolve({ botToken: '  secret-token  ' }));

    const response = await routes['/api/v1/app/telegram/token'].PUT(
      makeRequest('http://localhost/api/app/telegram/token', 'PUT', { botToken: 'secret-token' }),
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
    parseJsonBody.mockImplementation(() => Promise.resolve({ botToken: 'bad-token' }));

    const response = await routes['/api/v1/app/telegram/token'].PUT(
      makeRequest('http://localhost/api/app/telegram/token', 'PUT', { botToken: 'bad-token' }),
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
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve(uiSettings));
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
    parseJsonBody.mockImplementation(() => Promise.resolve({ botToken: 'typed-token' }));

    const response = await routes['/api/v1/app/telegram/token/test'].POST(
      makeRequest('http://localhost/api/app/telegram/token/test', 'POST', { botToken: 'typed-token' }),
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
    expect(telegramSettings.completeRecipientLink).toHaveBeenCalled();
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
});

describe('saved searches API', () => {
  const getHandler = appRoutes['/api/v1/app/saved-searches'].GET;
  const postHandler = appRoutes['/api/v1/app/saved-searches'].POST;
  const putHandler = appRoutes['/api/v1/app/saved-searches'].PUT;
  const deleteHandler = appRoutes['/api/v1/app/saved-searches'].DELETE;
  const reorderHandler = appRoutes['/api/v1/app/saved-searches/reorder'].PUT;

  beforeEach(() => {
    ctx.settings.getSavedSearches.mockClear();
    ctx.settings.addSavedSearch.mockClear();
    ctx.settings.updateSavedSearch.mockClear();
    ctx.settings.removeSavedSearch.mockClear();
    ctx.settings.reorderSavedSearches.mockClear();
    parseJsonBody.mockClear();
  });

  it('returns saved searches', async () => {
    const searches = [{ id: 's1', title: 'Ops', query: 'tag:ops', showAsSidebarPill: false, showInSidebarMenu: true, showInSearchDialog: true, createdAt: 't', updatedAt: 't' }];
    ctx.settings.getSavedSearches.mockImplementation(() => Promise.resolve(searches));

    const response = await getHandler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.savedSearches).toEqual(searches);
  });

  it('creates a saved search with valid payload', async () => {
    ctx.settings.addSavedSearch.mockImplementation(async (s) => s);
    parseJsonBody.mockImplementation(() => Promise.resolve({
      title: 'My search',
      query: 'status:unread',
      showAsSidebarPill: true,
      showInSidebarMenu: false,
      showInSearchDialog: true,
    }));

    const response = await postHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'POST', {}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.addSavedSearch).toHaveBeenCalledWith(expect.objectContaining({
      title: 'My search',
      query: 'status:unread',
      showAsSidebarPill: true,
      showInSidebarMenu: false,
      showInSearchDialog: true,
    }));
  });

  it('rejects create when query is empty', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ query: '' }));

    const response = await postHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'POST', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('query is required');
  });

  it('rejects create when no visibility options are enabled', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      query: 'status:active',
      showAsSidebarPill: false,
      showInSidebarMenu: false,
      showInSearchDialog: false,
    }));

    const response = await postHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'POST', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('at least one visibility option is required');
  });

  it('deletes a saved search by id', async () => {
    ctx.settings.removeSavedSearch.mockImplementation(() => Promise.resolve(true));

    const response = await deleteHandler(undefined, new URL('http://localhost/api/v1/app/saved-searches?id=s1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.removeSavedSearch).toHaveBeenCalledWith('s1');
  });

  it('rejects update that disables all visibility options', async () => {
    ctx.settings.getSavedSearches.mockImplementation(() => Promise.resolve([
      { id: 's1', title: null, query: 'status:active', showAsSidebarPill: true, showInSidebarMenu: false, showInSearchDialog: false, createdAt: 't', updatedAt: 't' },
    ]));
    parseJsonBody.mockImplementation(() => Promise.resolve({
      id: 's1',
      showAsSidebarPill: false,
      showInSidebarMenu: false,
      showInSearchDialog: false,
    }));

    const response = await putHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('at least one visibility option is required');
  });

  it('allows update that changes visibility targets', async () => {
    ctx.settings.getSavedSearches.mockImplementation(() => Promise.resolve([
      { id: 's1', title: null, query: 'status:active', showAsSidebarPill: true, showInSidebarMenu: false, showInSearchDialog: false, createdAt: 't', updatedAt: 't' },
    ]));
    ctx.settings.updateSavedSearch.mockImplementation(async (_id, patch) => ({
      id: 's1', title: null, query: 'status:active', showAsSidebarPill: false, showInSidebarMenu: true, showInSearchDialog: true, createdAt: 't', updatedAt: patch.updatedAt,
    }));
    parseJsonBody.mockImplementation(() => Promise.resolve({
      id: 's1',
      showAsSidebarPill: false,
      showInSidebarMenu: true,
      showInSearchDialog: true,
    }));

    const response = await putHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 404 when updating non-existent saved search', async () => {
    ctx.settings.getSavedSearches.mockImplementation(() => Promise.resolve([]));
    parseJsonBody.mockImplementation(() => Promise.resolve({ id: 'missing', query: 'test' }));

    const response = await putHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Saved search not found');
  });

  it('reorders saved searches', async () => {
    ctx.settings.reorderSavedSearches.mockImplementation(() => Promise.resolve({ success: true }));
    parseJsonBody.mockImplementation(() => Promise.resolve({
      oldOrder: ['a', 'b'],
      newOrder: ['b', 'a'],
    }));

    const response = await reorderHandler(makeRequest('http://localhost/api/v1/app/saved-searches/reorder', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });
});

describe('folders API', () => {
  const getHandler = appRoutes['/api/v1/app/folders'].GET;
  const postHandler = appRoutes['/api/v1/app/folders'].POST;
  const putHandler = appRoutes['/api/v1/app/folders'].PUT;
  const deleteHandler = appRoutes['/api/v1/app/folders'].DELETE;

  beforeEach(() => {
    ctx.settings.getFolders.mockClear();
    ctx.settings.addFolder.mockClear();
    ctx.settings.updateFolder.mockClear();
    ctx.settings.removeFolder.mockClear();
    parseJsonBody.mockClear();
  });

  it('returns saved folders', async () => {
    const folders = [{ id: 'folder-1', name: 'Review', filter: { textTokens: ['bug'], tags: [], agents: [], models: [] }, createdAt: '2026-03-27T00:00:00.000Z' }];
    ctx.settings.getFolders.mockImplementation(() => Promise.resolve(folders));

    const response = await getHandler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.folders).toEqual(folders);
  });

  it('sanitizes folder filters when creating a folder', async () => {
    ctx.settings.addFolder.mockImplementation(async (folder) => folder);
    parseJsonBody.mockImplementation(() => Promise.resolve({
      name: ' Important review ',
      filter: {
        textTokens: [' bug ', '', 7],
        tags: [' triage ', null],
        agents: [' codex '],
        models: [' gpt-5.4 ', false],
        status: ' unread ',
				ignored: ['value'],
			},
		}));

    const response = await postHandler(makeRequest('http://localhost/api/app/folders', 'POST', {}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.addFolder).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String),
      name: 'Important review',
      filter: {
        textTokens: ['bug'],
        tags: ['triage'],
        agents: ['codex'],
        models: ['gpt-5.4'],
					status: 'unread',
      },
				createdAt: expect.any(String),
			}));
		});

  it('sanitizes folder filters when updating a folder', async () => {
    ctx.settings.updateFolder.mockImplementation(async (_id, patch) => ({ id: 'folder-1', name: 'Saved', createdAt: '2026-03-27T00:00:00.000Z', ...patch }));
    parseJsonBody.mockImplementation(() => Promise.resolve({
      id: 'folder-1',
      filter: {
        textTokens: [' one '],
        tags: [' alpha ', ''],
        agents: [' codex '],
        models: [' gpt-5 '],
				status: 'invalid',
			},
		}));

    const response = await putHandler(makeRequest('http://localhost/api/app/folders', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.updateFolder).toHaveBeenCalledWith('folder-1', {
      filter: {
        textTokens: ['one'],
        tags: ['alpha'],
        agents: ['codex'],
        models: ['gpt-5'],
      },
    });
  });

  it('rejects whitespace-only folder names when updating a folder', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      id: 'folder-1',
      name: '   ',
    }));

    const response = await putHandler(makeRequest('http://localhost/api/app/folders', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('name is required');
    expect(ctx.settings.updateFolder).not.toHaveBeenCalled();
  });

  it('deletes a folder by id', async () => {
    ctx.settings.removeFolder.mockImplementation(() => Promise.resolve(true));

    const response = await deleteHandler(undefined, new URL('http://localhost/api/app/folders?id=folder-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.removeFolder).toHaveBeenCalledWith('folder-1');
  });
});
