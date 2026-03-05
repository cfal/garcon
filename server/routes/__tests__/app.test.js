import { describe, it, expect, beforeEach, mock } from 'bun:test';

mock.module('../../lib/http-native.js', () => ({
  parseJsonBody: mock(() => undefined),
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => '/home'),
}));

import createWorkspaceRoutes from '../workspace.js';
import { parseJsonBody } from '../../lib/http-native.js';

function createMockCtx() {
  return {
    settings: {
      setSessionName: mock(() => Promise.resolve(undefined)),
      getUiSettings: mock(() => Promise.resolve({})),
      setUiSettings: mock(() => Promise.resolve({})),
      getPathSettings: mock(() => Promise.resolve({})),
      setPathSettings: mock(() => Promise.resolve({})),
      getPinnedChatIds: mock(() => Promise.resolve([])),
      getLastPermissionMode: mock(() => Promise.resolve('default')),
      setLastPermissionMode: mock(() => Promise.resolve(undefined)),
      getLastThinkingMode: mock(() => Promise.resolve('none')),
      setLastThinkingMode: mock(() => Promise.resolve(undefined)),
    },
    providers: {
      getAuthStatusMap: mock(() => Promise.resolve({
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
      })),
      getModels: mock(() => Promise.resolve([])),
    },
  };
}

const ctx = createMockCtx();
const appRoutes = createWorkspaceRoutes(ctx.settings, ctx.providers);

function makeRequest(body) {
  return new Request('http://localhost/api/app/session-name', {
    method: 'PUT',
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
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.setLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.setLastThinkingMode.mockClear();
    ctx.providers.getAuthStatusMap.mockClear();
    ctx.providers.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('sets a session name with valid payload', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: '123', title: 'My Chat' }));

    const response = await handler(makeRequest({ chatId: '123', title: 'My Chat' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.setSessionName).toHaveBeenCalledWith('123', 'My Chat');
  });

  it('returns 400 when chatId is missing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ title: 'My Chat' }));

    const response = await handler(makeRequest({ title: 'My Chat' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('chatId is required');
  });

  it('returns 400 when title is empty', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: '123', title: '' }));

    const response = await handler(makeRequest({ chatId: '123', title: '' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('title is required');
  });

  it('returns 400 when title is whitespace-only', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: '123', title: '   ' }));

    const response = await handler(makeRequest({ chatId: '123', title: '   ' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('title is required');
  });

  it('trims the title before saving', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ chatId: '123', title: '  Trimmed  ' }));

    await handler(makeRequest({ chatId: '123', title: '  Trimmed  ' }));

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
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.setLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.setLastThinkingMode.mockClear();
    ctx.providers.getAuthStatusMap.mockClear();
    ctx.providers.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('returns ui, paths, pinnedChatIds, and recent mode settings', async () => {
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({ theme: 'dark' }));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({ lastDir: '/home' }));
    ctx.settings.getPinnedChatIds.mockImplementation(() => Promise.resolve(['a', 'b']));
    ctx.settings.getLastPermissionMode.mockImplementation(() => Promise.resolve('acceptEdits'));
    ctx.settings.getLastThinkingMode.mockImplementation(() => Promise.resolve('think-hard'));

    const response = await handler();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.ui).toEqual({ theme: 'dark' });
    expect(body.paths).toEqual({ lastDir: '/home' });
    expect(body.pinnedChatIds).toEqual(['a', 'b']);
    expect(body.lastPermissionMode).toBe('acceptEdits');
    expect(body.lastThinkingMode).toBe('think-hard');
    expect(body.uiEffective.chatTitle.enabled).toBe(false);
    expect(body.uiEffective.chatTitle.provider).toBe('claude');
    expect(body.uiEffective.chatTitle.model).toBe('haiku');
    expect(body.uiEffective.commitMessage.enabled).toBe(false);
    expect(body.uiEffective.commitMessage.provider).toBe('claude');
    expect(body.uiEffective.commitMessage.model).toBe('haiku');
    expect(body.chatSortOrder).toBeUndefined();
  });

  it('auto-enables generation defaults from authenticated provider priority', async () => {
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.providers.getAuthStatusMap.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: true },
      opencode: { authenticated: true },
    }));
    ctx.providers.getModels.mockImplementation(() => Promise.resolve([
      { value: 'deepseek-r1', label: 'DeepSeek R1' },
      { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
    ]));

    const response = await handler();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.uiEffective.chatTitle.enabled).toBe(true);
    expect(body.uiEffective.chatTitle.provider).toBe('codex');
    expect(body.uiEffective.chatTitle.model).toBe('gpt-5.1-codex-mini');
    expect(body.uiEffective.commitMessage.enabled).toBe(true);
    expect(body.uiEffective.commitMessage.provider).toBe('codex');
    expect(body.uiEffective.commitMessage.model).toBe('gpt-5.1-codex-mini');
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
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.setLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.setLastThinkingMode.mockClear();
    ctx.providers.getAuthStatusMap.mockClear();
    ctx.providers.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('patches ui settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ ui: { fontSize: 14 } }));
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({ fontSize: 14 }));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({}));

    const response = await handler(makeRequest({ ui: { fontSize: 14 } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ fontSize: 14 });
  });

  it('patches paths settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ paths: { lastDir: '/tmp' } }));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.settings.setPathSettings.mockImplementation(() => Promise.resolve({ lastDir: '/tmp' }));

    const response = await handler(makeRequest({ paths: { lastDir: '/tmp' } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setPathSettings).toHaveBeenCalledWith({ lastDir: '/tmp' });
  });

  it('patches ui.chatTitle settings', async () => {
    const chatTitleConfig = { enabled: true, provider: 'opencode', model: 'anthropic/claude-sonnet-4-5' };
    parseJsonBody.mockImplementation(() => Promise.resolve({ ui: { chatTitle: chatTitleConfig } }));
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({ chatTitle: chatTitleConfig }));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({}));

    const response = await handler(makeRequest({ ui: { chatTitle: chatTitleConfig } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ chatTitle: chatTitleConfig });
  });

  it('patches last used permission and thinking mode', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ lastPermissionMode: 'acceptEdits', lastThinkingMode: 'think-hard' }));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({}));
    ctx.settings.getLastPermissionMode.mockImplementation(() => Promise.resolve('acceptEdits'));
    ctx.settings.getLastThinkingMode.mockImplementation(() => Promise.resolve('think-hard'));

    const response = await handler(makeRequest({ lastPermissionMode: 'acceptEdits', lastThinkingMode: 'think-hard' }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setLastPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(ctx.settings.setLastThinkingMode).toHaveBeenCalledWith('think-hard');
    expect(body.lastPermissionMode).toBe('acceptEdits');
    expect(body.lastThinkingMode).toBe('think-hard');
  });
});
