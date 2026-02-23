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
  };
}

const ctx = createMockCtx();
const appRoutes = createWorkspaceRoutes(ctx.settings);

const allMocks = [
  ctx.settings.setSessionName, ctx.settings.getUiSettings, ctx.settings.setUiSettings,
  ctx.settings.getPathSettings, ctx.settings.setPathSettings, ctx.settings.getPinnedChatIds,
  ctx.settings.getLastPermissionMode, ctx.settings.setLastPermissionMode,
  ctx.settings.getLastThinkingMode, ctx.settings.setLastThinkingMode,
  parseJsonBody,
];

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
    allMocks.forEach(m => m.mockClear());
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
    allMocks.forEach(m => m.mockClear());
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
    expect(body.chatSortOrder).toBeUndefined();
  });
});

describe('PUT /api/app/settings', () => {
  const handler = appRoutes['/api/v1/app/settings'].PUT;

  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
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
