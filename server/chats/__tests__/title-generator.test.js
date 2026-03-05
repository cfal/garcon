import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { maybeGenerateChatTitle } from '../title-generator.js';

const runSingleQueryMock = mock(() => Promise.resolve('Test Chat Title'));
const getAuthStatusMapMock = mock(() => Promise.resolve({
  claude: { authenticated: false },
  codex: { authenticated: false },
  opencode: { authenticated: false },
}));
const getModelsMock = mock(() => Promise.resolve([]));
const mockProviders = {
  runSingleQuery: runSingleQueryMock,
  getAuthStatusMap: getAuthStatusMapMock,
  getModels: getModelsMock,
};

const setSessionNameMock = mock(() => Promise.resolve(undefined));
const getChatNameMock = mock(() => null);
const getUiSettingsMock = mock(() => Promise.resolve({
  chatTitle: { enabled: true, provider: 'claude', model: 'opus' },
}));
const mockSettings = {
  getUiSettings: getUiSettingsMock,
  getChatName: getChatNameMock,
  setSessionName: setSessionNameMock,
};

const allMocks = [
  runSingleQueryMock, setSessionNameMock,
  getChatNameMock, getUiSettingsMock, getAuthStatusMapMock, getModelsMock,
];

describe('maybeGenerateChatTitle', () => {
  beforeEach(() => {
    allMocks.forEach(m => m.mockClear());
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: { enabled: true, provider: 'claude', model: 'opus' },
    }));
    getAuthStatusMapMock.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: false },
      opencode: { authenticated: false },
    }));
    getModelsMock.mockImplementation(() => Promise.resolve([]));
    runSingleQueryMock.mockImplementation(() => Promise.resolve('Test Chat Title'));
    getChatNameMock.mockImplementation(() => null);
  });

  it('generates and persists a title when enabled', async () => {
    await maybeGenerateChatTitle({
      chatId: '100',
      projectPath: '/proj',
      firstPrompt: 'Help me fix a bug',
      providers: mockProviders,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).toHaveBeenCalledTimes(1);
    const [prompt, opts] = runSingleQueryMock.mock.calls[0];
    expect(prompt).toContain('Help me fix a bug');
    expect(opts.provider).toBe('claude');
    expect(opts.model).toBe('opus');

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
      providers: mockProviders,
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
      providers: mockProviders,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).not.toHaveBeenCalled();
  });

  it('auto-enables and defaults to codex when codex is authenticated', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({}));
    getAuthStatusMapMock.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: true },
      opencode: { authenticated: true },
    }));

    await maybeGenerateChatTitle({
      chatId: '301',
      projectPath: '/proj',
      firstPrompt: 'Hello',
      providers: mockProviders,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).toHaveBeenCalledTimes(1);
    const [, opts] = runSingleQueryMock.mock.calls[0];
    expect(opts.provider).toBe('codex');
    expect(opts.model).toBe('gpt-5.1-codex-mini');
  });

  it('auto-enables and skips DeepSeek R1 when selecting OpenCode defaults', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({}));
    getAuthStatusMapMock.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: false },
      opencode: { authenticated: true },
    }));
    getModelsMock.mockImplementation(() => Promise.resolve([
      { value: 'deepseek-r1', label: 'DeepSeek R1' },
      { value: 'deepseek-v3', label: 'DeepSeek V3' },
    ]));

    await maybeGenerateChatTitle({
      chatId: '302',
      projectPath: '/proj',
      firstPrompt: 'Hello',
      providers: mockProviders,
      settings: mockSettings,
    });

    expect(runSingleQueryMock).toHaveBeenCalledTimes(1);
    const [, opts] = runSingleQueryMock.mock.calls[0];
    expect(opts.provider).toBe('opencode');
    expect(opts.model).toBe('deepseek-v3');
  });

  it('does nothing when firstPrompt is empty', async () => {
    await maybeGenerateChatTitle({
      chatId: '400',
      projectPath: '/proj',
      firstPrompt: '',
      providers: mockProviders,
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
      providers: mockProviders,
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
      providers: mockProviders,
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
      providers: mockProviders,
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
      providers: mockProviders,
      settings: mockSettings,
    });

    expect(setSessionNameMock).not.toHaveBeenCalled();
  });

  it('routes to the configured provider', async () => {
    getUiSettingsMock.mockImplementation(() => Promise.resolve({
      chatTitle: { enabled: true, provider: 'opencode', model: 'anthropic/claude-sonnet-4-5' },
    }));

    await maybeGenerateChatTitle({
      chatId: '900',
      projectPath: '/proj',
      firstPrompt: 'Do something',
      providers: mockProviders,
      settings: mockSettings,
    });

    const [, opts] = runSingleQueryMock.mock.calls[0];
    expect(opts.provider).toBe('opencode');
    expect(opts.model).toBe('anthropic/claude-sonnet-4-5');
  });
});
