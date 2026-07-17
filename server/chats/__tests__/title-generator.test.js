import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { generateChatTitleFromMessage, maybeGenerateChatTitle } from '../title-generator.js';

const runSingleQueryMock = mock(() => Promise.resolve('Test Chat Title'));
const getAgentAuthStatusMapMock = mock(() => Promise.resolve({
  claude: { authenticated: false },
  codex: { authenticated: false },
  opencode: { authenticated: false },
}));
const getAgentReadinessMapMock = mock(() => Promise.resolve({}));
const getAgentCatalogEntriesMock = mock(() => Promise.resolve([]));
const getModelsMock = mock(() => Promise.resolve([]));
const mockAgents = {
  runSingleQuery: runSingleQueryMock,
  getAgentAuthStatusMap: getAgentAuthStatusMapMock,
  getAgentReadinessMap: getAgentReadinessMapMock,
  getAgentCatalogEntries: getAgentCatalogEntriesMock,
  getModels: getModelsMock,
  getAgentCatalog: mock(() => Promise.resolve({ agents: [], apiProviders: [] })),
};

const setSessionNameMock = mock(() => Promise.resolve(undefined));
const getChatNameMock = mock(() => null);
const getUiSettingsMock = mock(() => Promise.resolve({
  chatTitle: { enabled: true, agentId: 'claude', model: 'opus' },
}));
const mockSettings = {
  getUiSettings: getUiSettingsMock,
  getChatName: getChatNameMock,
  setSessionName: setSessionNameMock,
};

const allMocks = [
  runSingleQueryMock, setSessionNameMock,
  getChatNameMock, getUiSettingsMock, getAgentAuthStatusMapMock,
  getAgentReadinessMapMock, getAgentCatalogEntriesMock, getModelsMock, mockAgents.getAgentCatalog,
];

describe('maybeGenerateChatTitle', () => {
  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: { enabled: true, agentId: 'claude', model: 'opus' },
    }));
    getAgentAuthStatusMapMock.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: false },
      opencode: { authenticated: false },
    }));
    getAgentReadinessMapMock.mockImplementation(() => Promise.resolve({}));
    getAgentCatalogEntriesMock.mockImplementation(() => Promise.resolve([]));
    getModelsMock.mockImplementation(() => Promise.resolve([]));
    runSingleQueryMock.mockImplementation(() => Promise.resolve('Test Chat Title'));
    getChatNameMock.mockImplementation(() => null);
  });

  it('generates and persists a title when enabled', async () => {
    await maybeGenerateChatTitle({
      chatId: '100',
      projectPath: '/proj',
      firstPrompt: 'Help me fix a bug',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).toHaveBeenCalledTimes(1);
    const [prompt, opts] = runSingleQueryMock.mock.calls[0];
    expect(prompt).toContain('Help me fix a bug');
    expect(opts.agentId).toBe('claude');
    expect(opts.model).toBe('opus');
    expect(opts.thinkingMode).toBe('none');
    expect(opts.timeoutMs).toBe(110_000);

    expect(setSessionNameMock).toHaveBeenCalledWith('100', 'Test Chat Title');
  });

  it('does nothing when auto-title is disabled', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: { enabled: false },
    }));

    await maybeGenerateChatTitle({
      chatId: '200',
      projectPath: '/proj',
      firstPrompt: 'Hello',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).not.toHaveBeenCalled();
    expect(setSessionNameMock).not.toHaveBeenCalled();
  });

  it('does nothing when chatTitle config is absent', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({}));

    await maybeGenerateChatTitle({
      chatId: '300',
      projectPath: '/proj',
      firstPrompt: 'Hello',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).not.toHaveBeenCalled();
  });

  it('auto-enables and defaults to codex when codex is authenticated', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({}));
    getAgentAuthStatusMapMock.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: true },
      opencode: { authenticated: true },
    }));

    await maybeGenerateChatTitle({
      chatId: '301',
      projectPath: '/proj',
      firstPrompt: 'Hello',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).toHaveBeenCalledTimes(1);
    const [, opts] = runSingleQueryMock.mock.calls[0];
    expect(opts.agentId).toBe('codex');
    expect(opts.model).toBe('gpt-5.5');
    expect(opts.thinkingMode).toBe('none');
  });

  it('auto-enables and skips DeepSeek R1 when selecting OpenCode defaults', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({}));
    getAgentAuthStatusMapMock.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: false },
      opencode: { authenticated: true },
    }));
    getAgentCatalogEntriesMock.mockImplementation(() => Promise.resolve([
      {
        id: 'opencode',
        kind: 'agent',
        models: [
          { value: 'deepseek-r1', label: 'DeepSeek R1' },
          { value: 'deepseek-v3', label: 'DeepSeek V3' },
        ],
      },
    ]));

    await maybeGenerateChatTitle({
      chatId: '302',
      projectPath: '/proj',
      firstPrompt: 'Hello',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).toHaveBeenCalledTimes(1);
    const [, opts] = runSingleQueryMock.mock.calls[0];
    expect(opts.agentId).toBe('opencode');
    expect(opts.model).toBe('deepseek-v3');
  });

  it('does not auto-enable OpenCode title generation when no OpenCode models were discovered', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({}));
    getAgentAuthStatusMapMock.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: false },
      opencode: { authenticated: true },
    }));
    getAgentCatalogEntriesMock.mockImplementation(() => Promise.resolve([
      { id: 'opencode', kind: 'agent', models: [] },
    ]));

    await maybeGenerateChatTitle({
      chatId: '303',
      projectPath: '/proj',
      firstPrompt: 'Hello',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).not.toHaveBeenCalled();
  });

  it('does nothing when firstPrompt is empty', async () => {
    await maybeGenerateChatTitle({
      chatId: '400',
      projectPath: '/proj',
      firstPrompt: '',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).not.toHaveBeenCalled();
  });

  it('skips if a manual title already exists', async () => {
    getChatNameMock.mockImplementation(() => 'Manual Title');

    await maybeGenerateChatTitle({
      chatId: '500',
      projectPath: '/proj',
      firstPrompt: 'Some prompt',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).not.toHaveBeenCalled();
  });

  it('strips surrounding quotes from generated title', async () => {
    runSingleQueryMock.mockImplementation(() => Promise.resolve('"Quoted Title"'));

    await maybeGenerateChatTitle({
      chatId: '600',
      projectPath: '/proj',
      firstPrompt: 'A prompt',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(setSessionNameMock).toHaveBeenCalledWith('600', 'Quoted Title');
  });

  it('does not persist an empty generated title', async () => {
    runSingleQueryMock.mockImplementation(() => Promise.resolve(''));

    await maybeGenerateChatTitle({
      chatId: '700',
      projectPath: '/proj',
      firstPrompt: 'A prompt',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(setSessionNameMock).not.toHaveBeenCalled();
  });

  it('catches and logs errors without throwing', async () => {
    runSingleQueryMock.mockImplementation(() => Promise.reject(new Error('LLM timeout')));

    // Should not throw.
    await maybeGenerateChatTitle({
      chatId: '800',
      projectPath: '/proj',
      firstPrompt: 'A prompt',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(setSessionNameMock).not.toHaveBeenCalled();
  });

  it('routes to the configured agent', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: { enabled: true, agentId: 'opencode', model: 'anthropic/claude-sonnet-4-5' },
    }));

    await maybeGenerateChatTitle({
      chatId: '900',
      projectPath: '/proj',
      firstPrompt: 'Do something',
      agents: mockAgents,
      settings: mockSettings,
    });

    const [, opts] = runSingleQueryMock.mock.calls[0];
    expect(opts.agentId).toBe('opencode');
    expect(opts.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('forwards explicit generation effort without normalization by agent', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: {
        enabled: true,
        agentId: 'direct-openai-compatible',
        model: 'glm-5.2',
        thinkingMode: 'ultra',
      },
    }));

    await maybeGenerateChatTitle({
      chatId: 'effort-title',
      projectPath: '/proj',
      firstPrompt: 'Explain this change',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock.mock.calls[0][1]).toMatchObject({
      agentId: 'direct-openai-compatible',
      model: 'glm-5.2',
      thinkingMode: 'ultra',
      timeoutMs: 110_000,
    });
  });

  it('passes API provider metadata to configured title generation agent', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: {
        enabled: true,
        agentId: 'direct-openai-compatible',
        model: 'glm-5.1',
        apiProviderId: 'zai',
        modelEndpointId: 'zai_openai',
        modelProtocol: 'openai-compatible',
      },
    }));

    await maybeGenerateChatTitle({
      chatId: '901',
      projectPath: '/proj',
      firstPrompt: 'Do something',
      agents: mockAgents,
      settings: mockSettings,
    });

    const [, opts] = runSingleQueryMock.mock.calls[0];
    expect(opts.agentId).toBe('direct-openai-compatible');
    expect(opts.model).toBe('glm-5.1');
    expect(opts.apiProviderId).toBe('zai');
    expect(opts.modelEndpointId).toBe('zai_openai');
    expect(opts.modelProtocol).toBe('openai-compatible');
  });

  it('generates a manual title when automatic title generation is disabled with a configured model', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: { enabled: false, agentId: 'claude', model: 'opus' },
    }));

    const result = await generateChatTitleFromMessage({
      chatId: '1000',
      projectPath: '/proj',
      message: 'Debug composer layout jumps',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(result).toEqual({ chatId: '1000', title: 'Test Chat Title' });
    expect(runSingleQueryMock).toHaveBeenCalledTimes(1);
    expect(setSessionNameMock).toHaveBeenCalledWith('1000', 'Test Chat Title');
  });

  it('manual title generation overwrites an existing title', async () => {
    getChatNameMock.mockImplementation(() => 'Existing Title');

    await generateChatTitleFromMessage({
      chatId: '1001',
      projectPath: '/proj',
      message: 'New source message',
      agents: mockAgents,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).toHaveBeenCalledTimes(1);
    expect(setSessionNameMock).toHaveBeenCalledWith('1001', 'Test Chat Title');
  });

  it('manual title generation auto-selects a ready generation model when auto title generation is disabled', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: { enabled: false },
    }));
    getAgentAuthStatusMapMock.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: true },
      opencode: { authenticated: false },
    }));

    await generateChatTitleFromMessage({
      chatId: '1002',
      projectPath: '/proj',
      message: 'Generate this one-off title',
      agents: mockAgents,
      settings: mockSettings,
    });

    const [, opts] = runSingleQueryMock.mock.calls[0];
    expect(opts.agentId).toBe('codex');
    expect(opts.model).toBe('gpt-5.5');
  });

  it('manual title generation throws when no generation target is available', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: { enabled: false },
    }));

    await expect(generateChatTitleFromMessage({
      chatId: '1003',
      projectPath: '/proj',
      message: 'Hello',
      agents: mockAgents,
      settings: mockSettings,
    })).rejects.toMatchObject({
      code: 'TITLE_GENERATION_UNAVAILABLE',
      status: 409,
    });
    expect(runSingleQueryMock).not.toHaveBeenCalled();
  });
});
