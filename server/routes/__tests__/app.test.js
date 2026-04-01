import { describe, it, expect, beforeEach, mock } from 'bun:test';

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => undefined),
}));

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => '/home'),
  getTelegramBotToken: mock(() => ''),
}));

import createWorkspaceRoutes from '../workspace.js';
import { parseJsonBody } from '../../lib/http-request.js';

function createMockCtx() {
  return {
    settings: {
      setSessionName: mock(() => Promise.resolve(undefined)),
      getUiSettings: mock(() => Promise.resolve({})),
      setUiSettings: mock(() => Promise.resolve({})),
      getPathSettings: mock(() => Promise.resolve({})),
      setPathSettings: mock(() => Promise.resolve({})),
      getPinnedChatIds: mock(() => Promise.resolve([])),
      getLastProvider: mock(() => Promise.resolve('claude')),
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
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastProvider.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.providers.getAuthStatusMap.mockClear();
    ctx.providers.getModels.mockClear();
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
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastProvider.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.providers.getAuthStatusMap.mockClear();
    ctx.providers.getModels.mockClear();
    parseJsonBody.mockClear();
  });

  it('returns ui, paths, pinnedChatIds, and recent startup settings', async () => {
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({ theme: 'dark' }));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({ lastDir: '/home' }));
    ctx.settings.getPinnedChatIds.mockImplementation(() => Promise.resolve(['a', 'b']));
    ctx.settings.getLastProvider.mockImplementation(() => Promise.resolve('codex'));
    ctx.settings.getLastProjectPath.mockImplementation(() => Promise.resolve('/workspace/project'));
    ctx.settings.getLastModel.mockImplementation(() => Promise.resolve('gpt-5.4'));
    ctx.settings.getLastPermissionMode.mockImplementation(() => Promise.resolve('acceptEdits'));
    ctx.settings.getLastThinkingMode.mockImplementation(() => Promise.resolve('think-hard'));
    ctx.settings.getLastClaudeThinkingMode.mockImplementation(() => Promise.resolve('on'));

    const response = await handler();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.ui).toEqual({ theme: 'dark' });
    expect(body.paths).toEqual({ lastDir: '/home' });
    expect(body.pinnedChatIds).toEqual(['a', 'b']);
    expect(body.lastProvider).toBe('codex');
    expect(body.lastProjectPath).toBe('/workspace/project');
    expect(body.lastModel).toBe('gpt-5.4');
    expect(body.lastPermissionMode).toBe('acceptEdits');
    expect(body.lastThinkingMode).toBe('think-hard');
    expect(body.lastClaudeThinkingMode).toBe('on');
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

  it('preserves persisted commitMessage extra fields in uiEffective', async () => {
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({
      commitMessage: {
        enabled: true,
        provider: 'codex',
        model: 'gpt-5.1-codex-mini',
        customPrompt: 'Write a short message',
        useCommonDirPrefix: true,
      },
    }));

    const response = await handler();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.uiEffective.commitMessage.enabled).toBe(true);
    expect(body.uiEffective.commitMessage.provider).toBe('codex');
    expect(body.uiEffective.commitMessage.model).toBe('gpt-5.1-codex-mini');
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
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastProvider.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.providers.getAuthStatusMap.mockClear();
    ctx.providers.getModels.mockClear();
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
    const chatTitleConfig = { enabled: true, provider: 'opencode', model: 'anthropic/claude-sonnet-4-5' };
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
    const folders = [{ id: 'folder-1', name: 'Review', filter: { textTokens: ['bug'], tags: [], providers: [], models: [] }, createdAt: '2026-03-27T00:00:00.000Z' }];
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
        providers: [' codex '],
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
        providers: ['codex'],
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
        providers: [' codex '],
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
        providers: ['codex'],
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
