import { describe, it, expect, beforeEach, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => undefined),
  MalformedJsonError,
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => '/home'),
  isHttpCompressionEnabled: mock(() => true),
}));

import createWorkspaceRoutes from '../workspace.js';
import { parseJsonBody } from '../../lib/http-request.js';
import {
  FolderAlreadyExistsError,
  FolderNotFoundError,
  SavedSearchAlreadyExistsError,
  SavedSearchNotFoundError,
} from '../../settings/errors.js';

function remoteSettingsSource(overrides = {}) {
  return {
    version: 0,
    ui: {},
    paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
    pinnedChatIds: [],
    recentAgentSettings: [],
    executionDefaults: {
      global: {
        permissionMode: 'default',
        thinkingMode: 'none',
        claudeThinkingMode: 'auto',
        ampAgentMode: 'smart',
      },
      byAgent: {},
    },
    ...overrides,
  };
}

function createMockCtx() {
  return {
    settings: {
      getRemoteSettingsSnapshotSource: mock(() => remoteSettingsSource()),
      setSessionName: mock(() => Promise.resolve(undefined)),
      getRemoteSettingsVersion: mock(() => 0),
      getUiSettings: mock(() => ({})),
      setUiSettings: mock(() => Promise.resolve({})),
      getPathSettings: mock(() => ({})),
      setPathSettings: mock(() => Promise.resolve({})),
      getPinnedChatIds: mock(() => []),
      getFolders: mock(() => []),
      addFolder: mock(() => Promise.resolve(undefined)),
      updateFolder: mock(() => Promise.resolve(undefined)),
      removeFolder: mock(() => Promise.resolve(false)),
      getSavedSearches: mock(() => []),
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
      getAgentReadinessMap: mock(() => Promise.resolve({})),
      getAgentCatalogEntries: mock(() => Promise.resolve([])),
      getModels: mock(() => Promise.resolve([])),
    },
  };
}

const ctx = createMockCtx();
const appRoutes = createWorkspaceRoutes(ctx.settings, ctx.agents);

beforeEach(() => {
  ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource());
});

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

  it('returns 404 when the registry-backed chat does not exist', async () => {
    const routes = createWorkspaceRoutes(ctx.settings, ctx.agents, undefined, undefined, {
      getChat: mock(() => null),
    });
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: 'missing', title: 'Missing' }));

    const response = await routes['/api/v1/app/session-name'].PUT(
      makeRequest('http://localhost/api/app/session-name', 'PUT', { chatId: 'missing', title: 'Missing' }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('SESSION_NOT_FOUND');
    expect(ctx.settings.setSessionName).not.toHaveBeenCalled();
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
    ctx.agents.getAgentAuthStatusMap.mockClear();
    ctx.agents.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('returns ui, paths, pinnedChatIds, and recent startup settings', async () => {
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      version: 7,
      ui: { theme: 'dark' },
      paths: {
        pinnedProjectPaths: ['/home'],
        browseStartPath: '/workspace',
        recentProjectPaths: ['/workspace/project'],
      },
      pinnedChatIds: ['a', 'b'],
      recentAgentSettings: [
        {
          agentId: 'codex',
          model: 'gpt-5.4',
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
        byAgent: {
          codex: {
            permissionMode: 'acceptEdits',
            thinkingMode: 'medium',
            claudeThinkingMode: 'on',
            ampAgentMode: 'smart',
          },
        },
      },
    }));

    const response = await handler();
    const body = await response.json();

    expect(body.version).toBe(7);
    expect(body.ui).toEqual({ theme: 'dark' });
    expect(body.paths).toEqual({
      pinnedProjectPaths: ['/home'],
      browseStartPath: '/workspace',
      recentProjectPaths: ['/workspace/project'],
    });
    expect(body.pinnedChatIds).toEqual(['a', 'b']);
    expect(body.recentAgentSettings).toEqual([
      {
        agentId: 'codex',
        model: 'gpt-5.4',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
      },
    ]);
    expect(body.executionDefaults.byAgent.codex).toEqual({
      permissionMode: 'acceptEdits',
      thinkingMode: 'medium',
      claudeThinkingMode: 'on',
      ampAgentMode: 'smart',
    });
    for (const key of ['last' + 'AgentId', 'last' + 'ProjectPath', 'last' + 'Model', 'last' + 'PermissionMode']) {
      expect(body[key]).toBeUndefined();
    }
    expect(body.uiEffective.chatTitle.enabled).toBe(false);
    expect(body.uiEffective.chatTitle.agentId).toBe('claude');
    expect(body.uiEffective.chatTitle.model).toBe('haiku');
    expect(body.uiEffective.commitMessage.agentId).toBe('claude');
    expect(body.uiEffective.commitMessage.model).toBe('haiku');
    expect(body.uiEffective.commitMessage).not.toHaveProperty('enabled');
    expect(body.chatSortOrder).toBeUndefined();
  });

  it('auto-enables generation defaults from authenticated agent priority', async () => {
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({ version: 1 }));
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
    expect(body.uiEffective.commitMessage.agentId).toBe('codex');
    expect(body.uiEffective.commitMessage.model).toBe('gpt-5.5');
    expect(body.uiEffective.commitMessage).not.toHaveProperty('enabled');
  });

  it('preserves persisted commitMessage extra fields in uiEffective', async () => {
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      version: 3,
      ui: {
        commitMessage: {
          agentId: 'codex',
          model: 'gpt-5.5',
          customPrompt: 'Write a short message',
          useCommonDirPrefix: true,
        },
      },
    }));

    const response = await handler();
    const body = await response.json();

    expect(body.version).toBe(3);
    expect(body.uiEffective.commitMessage.agentId).toBe('codex');
    expect(body.uiEffective.commitMessage.model).toBe('gpt-5.5');
    expect(body.uiEffective.commitMessage.customPrompt).toBe('Write a short message');
    expect(body.uiEffective.commitMessage.useCommonDirPrefix).toBe(true);
    expect(body.uiEffective.commitMessage).not.toHaveProperty('enabled');
  });

  it('returns persisted app identity title in the settings snapshot', async () => {
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      version: 4,
      ui: {
        appIdentity: {
          title: 'Garcon - Work',
        },
      },
    }));

    const response = await handler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ui.appIdentity).toEqual({ title: 'Garcon - Work' });
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
    ctx.agents.getAgentAuthStatusMap.mockClear();
    ctx.agents.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('patches ui settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ ui: { fontSize: 14 } }));
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({ fontSize: 14 }));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { ui: { fontSize: 14 } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ fontSize: 14 });
  });

  it('patches paths settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ paths: { lastDir: '/tmp' } }));
    ctx.settings.getUiSettings.mockImplementation(() => ({}));
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
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { ui: { chatTitle: chatTitleConfig } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ chatTitle: chatTitleConfig });
  });

  it('patches browser notification settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      ui: {
        notifications: {
          browser: {
            enabled: true,
            previewMode: 'message-preview',
            endpoint: 'not-persisted-here',
          },
        },
      },
    }));
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({
      notifications: {
        browser: {
          enabled: true,
          previewMode: 'message-preview',
        },
      },
    }));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      notifications: {
        browser: {
          enabled: true,
          previewMode: 'message-preview',
        },
      },
    });
    expect(body.settings.browserNotifications).toEqual({
      vapidPublicKeyAvailable: false,
      subscriptionCount: 0,
    });
  });

  it('patches and trims ui.appIdentity title settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      ui: { appIdentity: { title: ' Garcon - Work ' } },
    }));
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({
      appIdentity: { title: 'Garcon - Work' },
    }));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      appIdentity: { title: 'Garcon - Work' },
    });
  });

  it('clears ui.appIdentity title settings with an empty object', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      ui: { appIdentity: {} },
    }));
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ appIdentity: {} });
  });

  it('rejects blank ui.appIdentity title settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      ui: { appIdentity: { title: '   ' } },
    }));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('title_required');
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it('rejects non-string ui.appIdentity title settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      ui: { appIdentity: { title: 42 } },
    }));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('title_invalid');
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it('rejects overlong ui.appIdentity title settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      ui: { appIdentity: { title: 'x'.repeat(121) } },
    }));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('title_too_long');
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it('does not patch startup defaults through app settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      recentAgentSettings: [
        {
          agentId: 'codex',
          model: 'gpt-5.4',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
        },
      ],
      executionDefaults: {
        byAgent: {
          codex: { permissionMode: 'acceptEdits' },
        },
      },
    }));
    ctx.settings.getUiSettings.mockImplementation(() => ({}));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', {}));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
    expect(ctx.settings.setPathSettings).not.toHaveBeenCalled();
    expect(body.settings.recentAgentSettings).toEqual([]);
    expect(body.settings.executionDefaults.byAgent).toEqual({});
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

  it('returns 409 when creating a duplicate saved search', async () => {
    ctx.settings.addSavedSearch.mockImplementation(() => Promise.reject(
      new SavedSearchAlreadyExistsError('duplicate'),
    ));
    parseJsonBody.mockImplementation(() => Promise.resolve({
      title: 'Duplicate',
      query: 'status:unread',
      showAsSidebarPill: true,
      showInSidebarMenu: false,
      showInSearchDialog: false,
    }));

    const response = await postHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'POST', {}));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('SAVED_SEARCH_ALREADY_EXISTS');
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
    expect(body.errorCode).toBe('SAVED_SEARCH_NOT_FOUND');
  });

  it('returns 404 when saved search disappears during update', async () => {
    ctx.settings.getSavedSearches.mockImplementation(() => [{
      id: 'gone',
      title: null,
      query: 'old',
      showAsSidebarPill: true,
      showInSidebarMenu: false,
      showInSearchDialog: false,
      createdAt: 't',
      updatedAt: 't',
    }]);
    ctx.settings.updateSavedSearch.mockImplementation(() => Promise.reject(new SavedSearchNotFoundError('gone')));
    parseJsonBody.mockImplementation(() => Promise.resolve({ id: 'gone', query: 'new' }));

    const response = await putHandler(makeRequest('http://localhost/api/v1/app/saved-searches', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('SAVED_SEARCH_NOT_FOUND');
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

  it('returns 409 when creating a duplicate folder', async () => {
    ctx.settings.addFolder.mockImplementation(() => Promise.reject(new FolderAlreadyExistsError('duplicate')));
    parseJsonBody.mockImplementation(() => Promise.resolve({ name: 'Duplicate' }));

    const response = await postHandler(makeRequest('http://localhost/api/app/folders', 'POST', {}));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.errorCode).toBe('FOLDER_ALREADY_EXISTS');
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

  it('returns 404 when updating a missing folder', async () => {
    ctx.settings.updateFolder.mockImplementation(() => Promise.reject(new FolderNotFoundError('folder-404')));
    parseJsonBody.mockImplementation(() => Promise.resolve({
      id: 'folder-404',
      name: 'Missing',
    }));

    const response = await putHandler(makeRequest('http://localhost/api/app/folders', 'PUT', {}));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('FOLDER_NOT_FOUND');
  });

  it('deletes a folder by id', async () => {
    ctx.settings.removeFolder.mockImplementation(() => Promise.resolve(true));

    const response = await deleteHandler(undefined, new URL('http://localhost/api/app/folders?id=folder-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.removeFolder).toHaveBeenCalledWith('folder-1');
  });

  it('returns 404 when deleting a missing folder', async () => {
    ctx.settings.removeFolder.mockImplementation(() => Promise.resolve(false));

    const response = await deleteHandler(undefined, new URL('http://localhost/api/app/folders?id=missing'));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('FOLDER_NOT_FOUND');
  });
});
