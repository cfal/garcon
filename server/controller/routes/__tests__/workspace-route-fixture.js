import { mock } from "bun:test";

export function remoteSettingsSource(overrides = {}) {
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
        agentSettingsById: {},
      },
      byAgent: {},
    },
    ...overrides,
  };
}

export function createWorkspaceFixture() {
  return {
    settings: {
      getRemoteSettingsSnapshotSource: mock(() => remoteSettingsSource()),
      setSessionName: mock((_chatId, title) => Promise.resolve({ title, changed: true })),
      getRemoteSettingsVersion: mock(() => 0),
      getUiSettings: mock(() => ({})),
      setUiSettings: mock(() => Promise.resolve({})),
      setFeatureSettings: mock(() => Promise.resolve({
        transcriptSearch: { enabled: false },
        agentCommands: {
          enabled: true,
          chatIdDiscovery: true,
          sendMessage: true,
          startAgent: true,
          resumeAgent: true,
          schedule: true,
        },
      })),
      getFeatureSettings: mock(() => ({
        transcriptSearch: { enabled: false },
        agentCommands: {
          enabled: true,
          chatIdDiscovery: true,
          sendMessage: true,
          startAgent: true,
          resumeAgent: true,
          schedule: true,
        },
      })),
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
      runSingleQuery: mock(() => Promise.resolve('OK')),
      singleQueryRunsToolsWithoutPermission: mock(() => false),
      assertExecutionModeSelectionSupported: mock(() => undefined),
    },
  };
}

export function makeRequest(url, method, body) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
