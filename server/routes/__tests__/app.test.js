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
    providers: {
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
    ctx.settings.getRemoteSettingsVersion.mockClear();
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastAgentId.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.providers.getAgentAuthStatusMap.mockClear();
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
    ctx.settings.getRemoteSettingsVersion.mockClear();
    ctx.settings.getPinnedChatIds.mockClear();
    ctx.settings.getLastAgentId.mockClear();
    ctx.settings.getLastProjectPath.mockClear();
    ctx.settings.getLastModel.mockClear();
    ctx.settings.getLastPermissionMode.mockClear();
    ctx.settings.getLastThinkingMode.mockClear();
    ctx.settings.getLastClaudeThinkingMode.mockClear();
    ctx.providers.getAgentAuthStatusMap.mockClear();
    ctx.providers.getModels.mockClear();
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

  it('strips the legacy remote sidebar controls position from the snapshot', async () => {
    ctx.settings.getRemoteSettingsVersion.mockImplementation(() => Promise.resolve(2));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({
      searchBarPosition: 'top',
      pinnedInsertPosition: 'bottom',
    }));

    const response = await handler();
    const body = await response.json();

    expect(body.ui).toEqual({ pinnedInsertPosition: 'bottom' });
  });

  it('auto-enables generation defaults from authenticated provider priority', async () => {
    ctx.settings.getRemoteSettingsVersion.mockImplementation(() => Promise.resolve(1));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.providers.getAgentAuthStatusMap.mockImplementation(() => Promise.resolve({
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
    ctx.providers.getAgentAuthStatusMap.mockClear();
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

  it('drops the legacy sidebar controls position from ui patches', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({ ui: { searchBarPosition: 'top' } }));
    ctx.settings.getUiSettings.mockImplementation(() => Promise.resolve({ pinnedInsertPosition: 'top' }));
    ctx.settings.getPathSettings.mockImplementation(() => Promise.resolve({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { ui: { searchBarPosition: 'top' } }));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
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
