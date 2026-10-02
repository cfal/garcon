import { describe, it, expect, beforeEach, mock } from "bun:test";
import { makeRequest } from "./workspace-route-fixture.js";
import { createWorkspaceFixture, remoteSettingsSource } from "./workspace-route-fixture.js";
import createWorkspaceRoutes from "../workspace.js";
import { CorruptStateFileError } from "../../../common/json-file-store.ts";
import { generationModelTestConfigurationKey } from "../../../../common/generation-test-contracts.js";
import { GENERATION_UI_SETTING_KEYS } from "../../../../common/settings.js";
import { DomainError } from "../../../common/domain-error.js";

let ctx;
let appRoutes;
beforeEach(() => {
  ctx = createWorkspaceFixture();
  appRoutes = createWorkspaceRoutes(ctx.settings, ctx.agents, undefined, undefined, "/worker/projects");
});

it.each([
  ['/api/v1/app/session-name', 'PUT'],
  ['/api/v1/app/settings', 'PUT'],
  ['/api/v1/app/generation/test', 'POST'],
  ['/api/v1/app/telegram/token', 'PUT'],
  ['/api/v1/app/folders', 'POST'],
  ['/api/v1/app/saved-searches', 'POST'],
])('rejects malformed JSON at %s before calling domain services', async (route, method) => {
  const url = new URL(route, 'http://localhost');
  const response = await appRoutes[route][method](new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: '{',
  }), url);

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ success: false, error: 'Malformed JSON' });
  for (const service of Object.values(ctx)) {
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  }
});

describe('PUT /api/app/session-name', () => {
  let handler;
  beforeEach(() => { handler = appRoutes['/api/v1/app/session-name'].PUT; });

  it('sets a session name with valid payload', async () => {
    const requestBody = { chatId: '123', title: 'My Chat' };

    const response = await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      chatId: '123',
      title: 'My Chat',
      changed: true,
    });
    expect(ctx.settings.setSessionName).toHaveBeenCalledWith('123', 'My Chat');
  });

  it('returns 400 when chatId is missing', async () => {
    const requestBody = { title: 'My Chat' };

    const response = await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid chat title request');
  });

  it('returns 400 when title is empty', async () => {
    const requestBody = { chatId: '123', title: '' };

    const response = await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid chat title request');
  });

  it('returns 400 when title is whitespace-only', async () => {
    const requestBody = { chatId: '123', title: '   ' };

    const response = await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid chat title request');
  });

  it('trims the title before saving', async () => {
    const requestBody = { chatId: '123', title: '  Trimmed  ' };

    await handler(makeRequest('http://localhost/api/app/session-name', 'PUT', requestBody));

    expect(ctx.settings.setSessionName).toHaveBeenCalledWith('123', 'Trimmed');
  });

  it('returns 404 when the registry-backed chat does not exist', async () => {
    const routes = createWorkspaceRoutes(ctx.settings, ctx.agents, undefined, undefined, '/worker/projects', {
      getChat: mock(() => null),
    });
    const requestBody = { chatId: 'missing', title: 'Missing' };

    const response = await routes['/api/v1/app/session-name'].PUT(
      makeRequest('http://localhost/api/app/session-name', 'PUT', requestBody),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.errorCode).toBe('SESSION_NOT_FOUND');
    expect(ctx.settings.setSessionName).not.toHaveBeenCalled();
  });
});

describe('GET /api/app/settings', () => {
  let handler;
  beforeEach(() => { handler = appRoutes['/api/v1/app/settings'].GET; });

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
          agentSettingsById: {},
        },
        byAgent: {
          codex: {
            permissionMode: 'acceptEdits',
            thinkingMode: 'medium',
            agentSettingsById: {
              codex: { ownerId: 'codex', schemaVersion: 1, values: {} },
            },
          },
        },
      },
    }));
    ctx.agents.getAgentCatalogEntries.mockImplementation(() => Promise.resolve([
      { id: 'claude', models: [], generation: { priority: 10, model: 'haiku' } },
    ]));

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
      agentSettingsById: {
        codex: { ownerId: 'codex', schemaVersion: 1, values: {} },
      },
    });
    for (const key of ['last' + 'AgentId', 'last' + 'ProjectPath', 'last' + 'Model', 'last' + 'PermissionMode']) {
      expect(body[key]).toBeUndefined();
    }
    expect(body.uiEffective.chatTitle.enabled).toBe(false);
    expect(body.uiEffective.chatTitle.agentId).toBe('claude');
    expect(body.uiEffective.chatTitle.model).toBe('haiku');
    expect(body.uiEffective.chatTitle.thinkingMode).toBe('none');
    expect(body.uiEffective.agentSwitchCompaction.contextWindowTokens).toBe(500_000);
    expect(body.uiEffective.commitMessage.agentId).toBe('claude');
    expect(body.uiEffective.commitMessage.model).toBe('haiku');
    expect(body.uiEffective.commitMessage.thinkingMode).toBe('none');
    expect(body.uiEffective.commitMessage).not.toHaveProperty('enabled');
    expect(body.uiEffective.promptRefinement.agentId).toBe('claude');
    expect(body.uiEffective.promptRefinement.model).toBe('haiku');
    expect(body.uiEffective.promptRefinement.thinkingMode).toBe('none');
    expect(body.uiEffective.promptRefinement).not.toHaveProperty('enabled');
    expect(body.chatSortOrder).toBeUndefined();
  });

  it('auto-resolves generation defaults without auto-enabling compaction', async () => {
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({ version: 1 }));
    ctx.agents.getAgentAuthStatusMap.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: true },
      opencode: { authenticated: true },
    }));
    ctx.agents.getAgentCatalogEntries.mockImplementation(() => Promise.resolve([
      { id: 'codex', models: [], generation: { priority: 10, model: 'gpt-5.5' } },
      { id: 'opencode', models: [], generation: { priority: 20, model: 'openai/gpt-4.1' } },
    ]));

    const response = await handler();
    const body = await response.json();

    expect(body.version).toBe(1);
    expect(body.uiEffective.chatTitle.enabled).toBe(true);
    expect(body.uiEffective.chatTitle.agentId).toBe('codex');
    expect(body.uiEffective.chatTitle.model).toBe('gpt-5.5');
    expect(body.uiEffective.agentSwitchCompaction.enabled).toBe(false);
    expect(body.uiEffective.agentSwitchCompaction.agentId).toBe('codex');
    expect(body.uiEffective.agentSwitchCompaction.model).toBe('gpt-5.5');
    expect(body.uiEffective.commitMessage.agentId).toBe('codex');
    expect(body.uiEffective.commitMessage.model).toBe('gpt-5.5');
    expect(body.uiEffective.commitMessage).not.toHaveProperty('enabled');
    expect(body.uiEffective.promptRefinement.agentId).toBe('codex');
    expect(body.uiEffective.promptRefinement.model).toBe('gpt-5.5');
    expect(body.uiEffective.promptRefinement).not.toHaveProperty('enabled');
  });

  it('preserves persisted commitMessage extra fields in uiEffective', async () => {
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      version: 3,
      ui: {
        commitMessage: {
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'max',
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
    expect(body.uiEffective.commitMessage.thinkingMode).toBe('max');
    expect(body.uiEffective.commitMessage.customPrompt).toBe('Write a short message');
    expect(body.uiEffective.commitMessage.useCommonDirPrefix).toBe(true);
    expect(body.uiEffective.commitMessage).not.toHaveProperty('enabled');
  });

  it('preserves persisted promptRefinement prompt fields in uiEffective', async () => {
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      version: 4,
      ui: {
        promptRefinement: {
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'high',
          customPrompt: 'Refine {{USER_PROMPT}}',
        },
      },
    }));

    const response = await handler();
    const body = await response.json();

    expect(body.uiEffective.promptRefinement).toEqual({
      executorId: 'local',
      agentId: 'codex',
      model: 'gpt-5.5',
      thinkingMode: 'high',
      customPrompt: 'Refine {{USER_PROMPT}}',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'manual',
    });
    expect(body.uiEffective.promptRefinement).not.toHaveProperty('enabled');
  });

  it('removes commit-only fields from persisted and effective title settings', async () => {
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      version: 4,
      ui: {
        chatTitle: {
          enabled: true,
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'medium',
          customPrompt: 'Unsupported title prompt',
          useCommonDirPrefix: true,
        },
      },
    }));

    const response = await handler();
    const body = await response.json();

    expect(body.ui.chatTitle).not.toHaveProperty('customPrompt');
    expect(body.ui.chatTitle).not.toHaveProperty('useCommonDirPrefix');
    expect(body.uiEffective.chatTitle).not.toHaveProperty('customPrompt');
    expect(body.uiEffective.chatTitle).not.toHaveProperty('useCommonDirPrefix');
  });

  it('preserves complete saved generation selections without catalog reconciliation', async () => {
    const chatTitle = {
      enabled: true,
      agentId: 'direct-openai-compatible',
      model: 'removed-from-catalog',
      apiProviderId: 'custom-provider',
      modelEndpointId: 'custom-endpoint',
      modelProtocol: 'openai-compatible',
      thinkingMode: 'max',
    };
    const commitMessage = {
      agentId: 'direct-anthropic-compatible',
      model: 'another-saved-model',
      apiProviderId: 'custom-provider',
      modelEndpointId: 'anthropic-endpoint',
      modelProtocol: 'anthropic-messages',
      thinkingMode: 'high',
    };
    const agentSwitchCompaction = {
      enabled: true,
      agentId: 'direct-openai-compatible',
      model: 'compaction-model',
      apiProviderId: 'custom-provider',
      modelEndpointId: 'custom-endpoint',
      modelProtocol: 'openai-compatible',
      thinkingMode: 'low',
      contextWindowTokens: 200_000,
    };
    const promptRefinement = {
      agentId: 'direct-openai-compatible',
      model: 'refinement-model',
      apiProviderId: 'custom-provider',
      modelEndpointId: 'custom-endpoint',
      modelProtocol: 'openai-compatible',
      thinkingMode: 'medium',
    };
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      ui: { chatTitle, agentSwitchCompaction, commitMessage, promptRefinement },
    }));

    const response = await handler();
    const body = await response.json();

    expect(body.uiEffective.chatTitle).toMatchObject(chatTitle);
    expect(body.uiEffective.agentSwitchCompaction).toMatchObject(agentSwitchCompaction);
    expect(body.uiEffective.commitMessage).toMatchObject(commitMessage);
    expect(body.uiEffective.promptRefinement).toMatchObject(promptRefinement);
    expect(ctx.agents.getAgentAuthStatusMap).not.toHaveBeenCalled();
    expect(ctx.agents.getAgentReadinessMap).not.toHaveBeenCalled();
    expect(ctx.agents.getAgentCatalogEntries).not.toHaveBeenCalled();
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

describe('POST /api/app/generation/test', () => {
  let handler;
  beforeEach(() => { handler = appRoutes['/api/v1/app/generation/test'].POST; });

  beforeEach(() => {
    ctx.settings.getUiSettings.mockImplementation(() => ({
      chatTitle: {
        agentId: 'claude',
        model: 'haiku',
        thinkingMode: 'high',
      },
    }));
    ctx.agents.runSingleQuery.mockClear();
    ctx.agents.runSingleQuery.mockImplementation(() => Promise.resolve('OK'));
    ctx.agents.singleQueryRunsToolsWithoutPermission.mockClear();
    ctx.agents.singleQueryRunsToolsWithoutPermission.mockImplementation(() => false);
    ctx.agents.getAgentAuthStatusMap.mockImplementation(() => Promise.resolve({}));
    ctx.agents.getAgentReadinessMap.mockImplementation(() => Promise.resolve({}));
    ctx.agents.getAgentCatalogEntries.mockImplementation(() => Promise.resolve([]));
  });

  it('tests the exact complete selection displayed by the settings snapshot', async () => {
    const chatTitle = {
      enabled: true,
      agentId: 'direct-openai-compatible',
      model: 'removed-from-catalog',
      apiProviderId: 'custom-provider',
      modelEndpointId: 'custom-endpoint',
      modelProtocol: 'openai-compatible',
      thinkingMode: 'max',
    };
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      ui: {
        chatTitle,
        commitMessage: { agentId: 'claude', model: 'haiku' },
      },
    }));
    ctx.settings.getUiSettings.mockImplementation(() => ({ chatTitle }));

    const settingsResponse = await appRoutes['/api/v1/app/settings'].GET();
    const snapshot = await settingsResponse.json();
    const requestBody = {
      target: 'chatTitle',
      configurationKey: generationModelTestConfigurationKey(snapshot.uiEffective.chatTitle),
    };

    const response = await handler(makeRequest(
      'http://localhost/api/v1/app/generation/test',
      'POST',
      requestBody,
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.agents.runSingleQuery).toHaveBeenCalledWith(
      'Reply with exactly OK. Do not use tools.',
      expect.objectContaining({
        agentId: chatTitle.agentId,
        model: chatTitle.model,
        apiProviderId: chatTitle.apiProviderId,
        modelEndpointId: chatTitle.modelEndpointId,
        modelProtocol: chatTitle.modelProtocol,
        thinkingMode: chatTitle.thinkingMode,
      }),
    );
  });

  it('tests a saved generation target without accepting configuration overrides', async () => {
    const requestBody = {
      target: 'chatTitle',
      configurationKey: generationModelTestConfigurationKey({
        agentId: 'claude',
        model: 'haiku',
        thinkingMode: 'high',
      }),
      prompt: 'ignored',
      model: 'ignored',
    };

    const response = await handler(makeRequest('http://localhost/api/app/generation/test', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, target: 'chatTitle' });
    expect(ctx.agents.runSingleQuery).toHaveBeenCalledWith(
      'Reply with exactly OK. Do not use tools.',
      expect.objectContaining({ model: 'haiku', thinkingMode: 'high' }),
    );
    expect(ctx.agents.runSingleQuery.mock.calls[0][1]).not.toHaveProperty('prompt');
  });

  it('rejects an unsafe saved prompt refinement target before invoking it', async () => {
    const promptRefinement = {
      agentId: 'amp',
      model: 'smart',
      thinkingMode: 'none',
    };
    ctx.settings.getUiSettings.mockImplementation(() => ({ promptRefinement }));
    ctx.agents.singleQueryRunsToolsWithoutPermission.mockImplementation(() => true);
    const requestBody = {
      target: 'promptRefinement',
      configurationKey: generationModelTestConfigurationKey(promptRefinement),
    };

    const response = await handler(makeRequest(
      'http://localhost/api/v1/app/generation/test',
      'POST',
      requestBody,
    ));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.errorCode).toBe('GENERATION_TEST_UNSAFE_AGENT');
    expect(ctx.agents.runSingleQuery).not.toHaveBeenCalled();
  });

  it('rejects invalid targets with a typed contract error', async () => {
    const requestBody = { target: 'chat' };

    const response = await handler(makeRequest('http://localhost/api/app/generation/test', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'Invalid generation test target.',
      errorCode: 'GENERATION_TEST_INVALID_TARGET',
      retryable: false,
    });
  });

  it('rejects a missing displayed-configuration key', async () => {
    const requestBody = { target: 'chatTitle' };

    const response = await handler(makeRequest('http://localhost/api/app/generation/test', 'POST', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('GENERATION_TEST_INVALID_CONFIGURATION');
    expect(ctx.agents.runSingleQuery).not.toHaveBeenCalled();
  });
});

describe('PUT /api/app/settings', () => {
  let handler;
  beforeEach(() => { handler = appRoutes['/api/v1/app/settings'].PUT; });

  it('reports corrupt settings state as an opaque server error', async () => {
    ctx.settings.setUiSettings.mockRejectedValueOnce(new CorruptStateFileError(
      '/server/config/project-settings.json',
      '/server/config/project-settings.json.corrupt-test',
    ));
    const requestBody = { ui: { fontSize: 14 } };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
    });
  });

  it('reports filesystem write failures as opaque server errors', async () => {
    ctx.settings.setUiSettings.mockRejectedValueOnce(new Error(
      "EACCES: permission denied, open '/server/config/.project-settings.json.tmp'",
    ));
    const requestBody = { ui: { fontSize: 14 } };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
    });
  });

  it('patches ui settings', async () => {
    const requestBody = { ui: { fontSize: 14 } };
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({ fontSize: 14 }));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ fontSize: 14 });
  });

  it('canonicalizes hidden bash command patterns before persistence', async () => {
    const input = [
      { pattern: 'git *', mode: 'glob' },
      { pattern: '^cargo', mode: 'regex' },
      { pattern: 'git *', mode: 'glob' },
    ];
    const expected = input.slice(0, 2);
    const requestBody = {
      ui: { hiddenBashCommandPatterns: input },
    };
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      ui: { hiddenBashCommandPatterns: expected },
    }));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      hiddenBashCommandPatterns: expected,
    });
    expect(body.settings.ui.hiddenBashCommandPatterns).toEqual(expected);
  });

  it('clears hidden bash command patterns with an empty list', async () => {
    const requestBody = {
      ui: { hiddenBashCommandPatterns: [] },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));

    expect(response.status).toBe(200);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ hiddenBashCommandPatterns: [] });
  });

  it('rejects malformed hidden bash command patterns before persistence', async () => {
    const validBoundary = Array.from(
      { length: 200 },
      (_, index) => ({ pattern: `command-${index}`, mode: 'glob' }),
    );
    const invalidLists = [
      'git *',
      [{ pattern: 'git *', mode: 'shell' }],
      [{ pattern: '', mode: 'glob' }],
      [{ pattern: '([unclosed', mode: 'regex' }],
      [...validBoundary, { ...validBoundary[0] }],
      [{ pattern: 'x'.repeat(1_001), mode: 'glob' }],
    ];

    for (const hiddenBashCommandPatterns of invalidLists) {
      ctx.settings.setUiSettings.mockClear();
      const requestBody = {
        ui: { hiddenBashCommandPatterns },
      };

      const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errorCode).toBe('INVALID_REMOTE_SETTINGS');
      expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
    }
  });

  it('patches paths settings', async () => {
    const requestBody = { paths: { lastDir: '/tmp' } };
    ctx.settings.getUiSettings.mockImplementation(() => ({}));
    ctx.settings.setPathSettings.mockImplementation(() => Promise.resolve({ lastDir: '/tmp' }));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setPathSettings).toHaveBeenCalledWith({ lastDir: '/tmp' });
  });

  it('patches transcript search only with a boolean setting', async () => {
    const requestBody = {
      features: { transcriptSearch: { enabled: true } },
    };
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      features: { transcriptSearch: { enabled: true } },
    }));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings.features.transcriptSearch.enabled).toBe(true);
    expect(ctx.settings.setFeatureSettings).toHaveBeenCalledWith({
      transcriptSearch: { enabled: true },
    });
  });

  it('rejects malformed transcript search settings', async () => {
    const requestBody = {
      features: { transcriptSearch: { enabled: 'yes' } },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.errorCode).toBe('INVALID_REMOTE_SETTINGS');
    expect(ctx.settings.setFeatureSettings).not.toHaveBeenCalled();
  });

  it('merges a partial agent command patch without losing sibling settings', async () => {
    const requestBody = {
      features: { agentCommands: { chatIdDiscovery: false } },
    };
    ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
      features: {
        transcriptSearch: { enabled: false },
        agentCommands: {
          enabled: true,
          chatIdDiscovery: false,
          sendMessage: false,
          startAgent: true,
          resumeAgent: true,
          schedule: true,
        },
      },
    }));
    ctx.settings.getFeatureSettings.mockImplementation(() => ({
      transcriptSearch: { enabled: false },
      agentCommands: {
        enabled: true,
        chatIdDiscovery: true,
        sendMessage: false,
        startAgent: true,
        resumeAgent: true,
        schedule: true,
      },
    }));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings.features.agentCommands.chatIdDiscovery).toBe(false);
    expect(ctx.settings.setFeatureSettings).toHaveBeenCalledWith({
      agentCommands: {
        enabled: true,
        chatIdDiscovery: false,
        sendMessage: false,
        startAgent: true,
        resumeAgent: true,
        schedule: true,
      },
    });
  });

  it('persists both feature toggles in one mutation', async () => {
    const requestBody = {
      features: {
        transcriptSearch: { enabled: true },
        agentCommands: { enabled: false },
      },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));

    expect(response.status).toBe(200);
    expect(ctx.settings.setFeatureSettings).toHaveBeenCalledTimes(1);
    expect(ctx.settings.setFeatureSettings).toHaveBeenCalledWith({
      transcriptSearch: { enabled: true },
      agentCommands: {
        enabled: false,
        chatIdDiscovery: true,
        sendMessage: true,
        startAgent: true,
        resumeAgent: true,
        schedule: true,
      },
    });
  });

  it('forwards the complete agent command object through unbounded transcript search maintenance', async () => {
    const transcriptSearchSettings = { setEnabled: mock(async () => undefined) };
    const server = { timeout: mock(() => undefined) };
    const routes = createWorkspaceRoutes(
      ctx.settings,
      ctx.agents,
      undefined,
      undefined,
      '/worker/projects',
      undefined,
      transcriptSearchSettings,
    );
    const requestBody = {
      features: {
        transcriptSearch: { enabled: true },
        agentCommands: { sendMessage: false },
      },
    };

    const request = makeRequest('http://localhost/api/app/settings', 'PUT', requestBody);
    const response = await routes['/api/v1/app/settings'].PUT(
      request,
      new URL(request.url),
      server,
    );

    expect(response.status).toBe(200);
    expect(transcriptSearchSettings.setEnabled).toHaveBeenCalledWith(true, {
      agentCommands: {
        enabled: true,
        chatIdDiscovery: true,
        sendMessage: false,
        startAgent: true,
        resumeAgent: true,
        schedule: true,
      },
    });
    expect(server.timeout).toHaveBeenCalledWith(request, 0);
    expect(ctx.settings.setFeatureSettings).not.toHaveBeenCalled();
  });

  it('rejects malformed agent command settings without mutation', async () => {
    ctx.settings.setFeatureSettings.mockClear();
    const requestBody = {
      features: {
        transcriptSearch: { enabled: true },
        agentCommands: { sendMessage: 'no' },
      },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('features.agentCommands.sendMessage must be a boolean');
    expect(body.errorCode).toBe('INVALID_REMOTE_SETTINGS');
    expect(ctx.settings.setFeatureSettings).not.toHaveBeenCalled();
  });

  it('patches ui.chatTitle settings', async () => {
    const chatTitleInput = {
      enabled: true,
      agentId: 'opencode',
      model: 'anthropic/claude-sonnet-4-5',
      customPrompt: 'Unsupported title prompt',
      useCommonDirPrefix: true,
    };
    const chatTitleConfig = {
      enabled: true,
      agentId: 'opencode',
      model: 'anthropic/claude-sonnet-4-5',
    };
    const requestBody = { ui: { chatTitle: chatTitleInput } };
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({ chatTitle: chatTitleConfig }));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ chatTitle: chatTitleConfig });
  });

  it('persists supported compaction context windows and drops invalid values', async () => {
    const requestBody = {
      ui: {
        agentSwitchCompaction: {
          enabled: true,
          contextWindowTokens: 200_000,
        },
      },
    };

    const validResponse = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));

    expect(validResponse.status).toBe(200);
    expect(ctx.settings.setUiSettings).toHaveBeenLastCalledWith({
      agentSwitchCompaction: {
        enabled: true,
        contextWindowTokens: 200_000,
      },
    });

    ctx.settings.setUiSettings.mockClear();
    const invalidRequestBody = {
      ui: {
        agentSwitchCompaction: {
          enabled: true,
          contextWindowTokens: 250_000,
        },
      },
    };

    const invalidResponse = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', invalidRequestBody));

    expect(invalidResponse.status).toBe(200);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      agentSwitchCompaction: { enabled: true },
    });
  });

  it('ignores a title settings patch containing only unsupported fields', async () => {
    const requestBody = {
      ui: {
        chatTitle: {
          customPrompt: 'Unsupported title prompt',
          useCommonDirPrefix: true,
        },
      },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it('preserves commit prompt settings while stripping title-only enabled state', async () => {
    const commitMessageInput = {
      enabled: false,
      agentId: 'codex',
      model: 'gpt-5.5',
      customPrompt: 'Summarize the diff',
      useCommonDirPrefix: true,
    };
    const requestBody = {
      ui: { commitMessage: commitMessageInput },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      commitMessage: {
        agentId: 'codex',
        model: 'gpt-5.5',
        customPrompt: 'Summarize the diff',
        useCommonDirPrefix: true,
      },
    });
  });

  it('preserves prompt refinement settings while stripping unrelated fields', async () => {
    const promptRefinementInput = {
      enabled: false,
      agentId: 'codex',
      model: 'gpt-5.5',
      customPrompt: 'Refine {{USER_PROMPT}}',
      useCommonDirPrefix: true,
    };
    const requestBody = {
      ui: { promptRefinement: promptRefinementInput },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));

    expect(response.status).toBe(200);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      promptRefinement: {
        agentId: 'codex',
        model: 'gpt-5.5',
        customPrompt: 'Refine {{USER_PROMPT}}',
      },
    });
  });

  it('preserves the ticket chat prompt while stripping execution settings', async () => {
    const requestBody = {
      ui: {
        ticketChat: {
          enabled: true,
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'high',
          executorId: 'remote',
          customPrompt: '{{ticket_id}}: {{ticket_title}}\n{{ticket_project}}\n{{ticket_description}}',
          useCommonDirPrefix: true,
        },
      },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));

    expect(response.status).toBe(200);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      ticketChat: {
        customPrompt: '{{ticket_id}}: {{ticket_title}}\n{{ticket_project}}\n{{ticket_description}}',
      },
    });
  });

  it('accepts an empty ticket chat prompt as the default prompt', async () => {
    const requestBody = { ui: { ticketChat: { customPrompt: '' } } };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));

    expect(response.status).toBe(200);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ ticketChat: { customPrompt: '' } });
  });

  it('rejects invalid generation prompt patches before persistence', async () => {
    const cases = [
      { commitMessage: { customPrompt: 42 } },
      { commitMessage: { customPrompt: 'x'.repeat(32_001) } },
      { promptRefinement: { customPrompt: 'Missing the required token' } },
      { promptRefinement: { customPrompt: 'x'.repeat(32_001) } },
      { ticketChat: { customPrompt: 7 } },
      { ticketChat: { customPrompt: 'Missing the ticket token' } },
      { ticketChat: { customPrompt: '{{ticket_id}} {{ticket}}' } },
      { ticketChat: { customPrompt: '{{ticket_id}} {{ticket_unknown}}' } },
      { ticketChat: { customPrompt: `{{ticket_id}}${'x'.repeat(32_000)}` } },
    ];

    for (const ui of cases) {
      ctx.settings.setUiSettings.mockClear();
      const requestBody = { ui };
      const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.errorCode).toBe('INVALID_REMOTE_SETTINGS');
      expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
    }
  });

  it.each(GENERATION_UI_SETTING_KEYS)('rejects invalid remote agent IDs for %s before persistence', async (target) => {
    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { ui: {
      [target]: { executorId: '22222222-2222-4222-8222-222222222222', agentId: '!', model: 'synthetic-model' },
    } }));
    expect(response.status).toBe(400);
    expect((await response.json()).errorCode).toBe('INVALID_REMOTE_SETTINGS');
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it.each(GENERATION_UI_SETTING_KEYS)('ignores malformed %s values rather than resetting to Auto', async (target) => {
    for (const malformed of [null, [], '', 0, false]) {
      const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { ui: { [target]: malformed } }));
      expect(response.status).toBe(200);
      expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
    }
  });

  it.each(GENERATION_UI_SETTING_KEYS)('accepts an explicit empty object to reset %s to Auto', async (target) => {
    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', { ui: { [target]: {} } }));
    expect(response.status).toBe(200);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ [target]: {} });
  });

  it('rejects unsupported generation efforts before mutating settings', async () => {
    ctx.agents.assertExecutionModeSelectionSupported.mockImplementation((agentId, selection) => {
      if (agentId === 'amp' && selection.thinkingMode === 'high') {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Thinking mode high is not supported by amp',
          422,
        );
      }
    });

    for (const target of GENERATION_UI_SETTING_KEYS) {
      ctx.settings.setUiSettings.mockClear();
      ctx.settings.setFeatureSettings.mockClear();
      ctx.settings.setPathSettings.mockClear();
      const requestBody = {
        ui: {
          [target]: {
            agentId: 'amp',
            model: 'medium',
            thinkingMode: 'high',
          },
        },
      };

      const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
      const body = await response.json();

      expect(response.status).toBe(422);
      expect(body.errorCode).toBe('VALIDATION_FAILED');
      expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
      expect(ctx.settings.setFeatureSettings).not.toHaveBeenCalled();
      expect(ctx.settings.setPathSettings).not.toHaveBeenCalled();
    }
  });

  it.each(GENERATION_UI_SETTING_KEYS)('allows non-selection edits to a kept unavailable %s target', async (target) => {
    const fixture = createWorkspaceFixture();
    const selection = {
      executorId: '22222222-2222-4222-8222-222222222222',
      agentId: 'codex', model: 'synthetic-model', thinkingMode: 'none',
    };
    fixture.settings.getUiSettings.mockImplementation(() => ({ [target]: selection }));
    fixture.agents.assertExecutionModeSelectionSupported.mockImplementation(() => {
      throw new DomainError('VALIDATION_FAILED', 'Unsupported agent', 422);
    });
    const routes = createWorkspaceRoutes(fixture.settings, fixture.agents, undefined, undefined, '/worker/projects');
    const response = await routes['/api/v1/app/settings'].PUT(makeRequest('http://localhost/api/v1/app/settings', 'PUT', {
      ui: { [target]: { ...selection, enabled: false, useCommonDirPrefix: true, contextWindowTokens: 200_000 } },
    }));
    expect(response.status).toBe(200);
    expect(fixture.agents.assertExecutionModeSelectionSupported).not.toHaveBeenCalled();
    expect(fixture.settings.setUiSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    { executorId: 'local' },
    { agentId: 'claude' },
    { thinkingMode: 'high' },
  ])('validates a changed generation selection: %j', async (changed) => {
    const fixture = createWorkspaceFixture();
    const selection = {
      executorId: '22222222-2222-4222-8222-222222222222',
      agentId: 'codex', model: 'synthetic-model', thinkingMode: 'none',
    };
    fixture.settings.getUiSettings.mockImplementation(() => ({ chatTitle: selection }));
    fixture.agents.assertExecutionModeSelectionSupported.mockImplementation(() => {
      throw new DomainError('VALIDATION_FAILED', 'Unsupported selection', 422);
    });
    const routes = createWorkspaceRoutes(fixture.settings, fixture.agents, undefined, undefined, '/worker/projects');
    const response = await routes['/api/v1/app/settings'].PUT(makeRequest('http://localhost/api/v1/app/settings', 'PUT', { ui: { chatTitle: { ...selection, ...changed } } }));
    expect(response.status).toBe(422);
    expect(fixture.agents.assertExecutionModeSelectionSupported).toHaveBeenCalledTimes(1);
    expect(fixture.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it('patches and trims ui.appIdentity title settings', async () => {
    const requestBody = {
      ui: { appIdentity: { title: ' Garcon - Work ' } },
    };
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({
      appIdentity: { title: 'Garcon - Work' },
    }));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({
      appIdentity: { title: 'Garcon - Work' },
    });
  });

  it('clears ui.appIdentity title settings with an empty object', async () => {
    const requestBody = {
      ui: { appIdentity: {} },
    };
    ctx.settings.setUiSettings.mockImplementation(() => Promise.resolve({}));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).toHaveBeenCalledWith({ appIdentity: {} });
  });

  it('rejects blank ui.appIdentity title settings', async () => {
    const requestBody = {
      ui: { appIdentity: { title: '   ' } },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('title_required');
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it('rejects non-string ui.appIdentity title settings', async () => {
    const requestBody = {
      ui: { appIdentity: { title: 42 } },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('title_invalid');
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it('rejects overlong ui.appIdentity title settings', async () => {
    const requestBody = {
      ui: { appIdentity: { title: 'x'.repeat(121) } },
    };

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('title_too_long');
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
  });

  it('does not patch startup defaults through app settings', async () => {
    const requestBody = {
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
    };
    ctx.settings.getUiSettings.mockImplementation(() => ({}));
    ctx.settings.getPathSettings.mockImplementation(() => ({}));

    const response = await handler(makeRequest('http://localhost/api/app/settings', 'PUT', requestBody));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(ctx.settings.setUiSettings).not.toHaveBeenCalled();
    expect(ctx.settings.setPathSettings).not.toHaveBeenCalled();
    expect(body.settings.recentAgentSettings).toEqual([]);
    expect(body.settings.executionDefaults.byAgent).toEqual({});
  });
});
