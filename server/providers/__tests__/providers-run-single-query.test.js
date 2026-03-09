// Tests for ProviderRegistry.runSingleQuery routing.
// claude-cli.js and codex.js standalone exports still need mock.module()
// because runSingleQuery imports them at the module level.
// opencode is injected via constructor as an instance with a
// runSingleQuery method.

import { describe, it, expect, mock, beforeEach } from 'bun:test';

const claudeMock = mock(async () => 'claude-response');
const codexMock = mock(async () => 'codex-response');

mock.module('../claude-cli.js', () => ({
  runSingleQuery: claudeMock,
  createClaudeNativePath: mock(() => Promise.resolve('/tmp/claude-session.jsonl')),
  ClaudeProvider: class { constructor() {} },
}));

mock.module('../codex.js', () => ({
  runSingleQuery: codexMock,
  CodexProvider: class { constructor() {} },
}));

// Mock the stateless loader imports that ProviderRegistry pulls in
mock.module('../loaders/claude-history-loader.js', () => ({
  getClaudePreviewFromNativePath: mock(() => Promise.resolve(null)),
  loadClaudeChatMessages: mock(() => Promise.resolve([])),
}));

mock.module('../loaders/codex-history-loader.js', () => ({
  getCodexPreviewFromNativePath: mock(() => Promise.resolve(null)),
  loadCodexChatMessages: mock(() => Promise.resolve([])),
}));

mock.module('../loaders/opencode-history-loader.js', () => ({
  getOpenCodePreviewFromSessionId: mock(() => Promise.resolve(null)),
  loadOpenCodeChatMessages: mock(() => Promise.resolve([])),
}));

const opencodeMock = mock(async () => 'opencode-response');
import { ProviderRegistry } from '../index.js';

describe('providers registry runSingleQuery', () => {
  const mockRegistry = {
    getChat: mock(() => null),
    getChatByProviderSessionId: mock(() => null),
  };
  const mockOpencode = { runSingleQuery: opencodeMock };
  const registry = new ProviderRegistry(mockRegistry, {}, {}, mockOpencode, {});

  it('routes to claude by default', async () => {
    const result = await registry.runSingleQuery('test prompt', {});
    expect(result).toBe('claude-response');
  });

  it('routes to claude when provider is explicit', async () => {
    const result = await registry.runSingleQuery('test prompt', { provider: 'claude' });
    expect(result).toBe('claude-response');
  });

  it('routes to codex provider', async () => {
    const result = await registry.runSingleQuery('test prompt', { provider: 'codex' });
    expect(result).toBe('codex-response');
  });

  it('routes to opencode provider', async () => {
    const result = await registry.runSingleQuery('test prompt', { provider: 'opencode' });
    expect(result).toBe('opencode-response');
  });

  it('passes options through to the provider', async () => {
    claudeMock.mockClear();
    await registry.runSingleQuery('hello', { provider: 'claude', model: 'opus', cwd: '/proj' });
    expect(claudeMock).toHaveBeenCalledWith('hello', { model: 'opus', cwd: '/proj' });
  });
});

describe('ProviderRegistry session option hydration', () => {
  let mockRegistry;
  let mockClaude;
  let mockCodex;
  let mockOpencode;
  let mockAmp;
  let registry;

  beforeEach(() => {
    mockRegistry = {
      getChat: mock(() => null),
      getChatByProviderSessionId: mock(() => null),
      updateChat: mock(() => undefined),
    };
    mockClaude = {
      startClaudeCliSession: mock(() => Promise.resolve('claude-session')),
      runClaudeTurn: mock(() => Promise.resolve(undefined)),
    };
    mockCodex = {
      startSession: mock(() => Promise.resolve('codex-session')),
      runTurn: mock(() => Promise.resolve(undefined)),
    };
    mockOpencode = {
      startSession: mock(() => Promise.resolve('opencode-session')),
      runTurn: mock(() => Promise.resolve(undefined)),
    };
    mockAmp = {
      startSession: mock(() => Promise.resolve('amp-session')),
      runTurn: mock(() => Promise.resolve(undefined)),
    };
    registry = new ProviderRegistry(mockRegistry, mockClaude, mockCodex, mockOpencode, mockAmp);
  });

  it('hydrates permission and thinking modes from the registry on new-session startup', async () => {
    mockRegistry.getChat.mockReturnValue({
      provider: 'opencode',
      projectPath: '/proj',
      model: 'openai/gpt-5',
      permissionMode: 'bypassPermissions',
      thinkingMode: 'think-hard',
    });

    await registry.startSession('123', 'hello', {});

    expect(mockOpencode.startSession).toHaveBeenCalledWith({
      command: 'hello',
      projectPath: '/proj',
      model: 'openai/gpt-5',
      permissionMode: 'bypassPermissions',
      thinkingMode: 'think-hard',
      chatId: '123',
    });
  });

  it('hydrates project path and execution modes from the registry on resumed turns', async () => {
    mockRegistry.getChat.mockReturnValue({
      provider: 'codex',
      projectPath: '/proj',
      providerSessionId: 'sess-1',
      model: 'gpt-5.4',
      permissionMode: 'bypassPermissions',
      thinkingMode: 'think-hard',
    });

    await registry.runProviderTurn('123', 'continue', {});

    expect(mockCodex.runTurn).toHaveBeenCalledWith({
      command: 'continue',
      providerSessionId: 'sess-1',
      chatId: '123',
      projectPath: '/proj',
      model: 'gpt-5.4',
      permissionMode: 'bypassPermissions',
      thinkingMode: 'think-hard',
    });
  });

  it('hydrates project path from the registry for resumed Claude turns', async () => {
    mockRegistry.getChat.mockReturnValue({
      provider: 'claude',
      projectPath: '/proj',
      providerSessionId: 'sess-2',
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    await registry.runProviderTurn('123', 'continue', {});

    expect(mockClaude.runClaudeTurn).toHaveBeenCalledWith({
      command: 'continue',
      providerSessionId: 'sess-2',
      chatId: '123',
      projectPath: '/proj',
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
    });
  });

  it('stores the derived native path when starting a Claude session', async () => {
    mockRegistry.getChat.mockReturnValue({
      provider: 'claude',
      projectPath: '/proj',
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    await registry.startSession('123', 'hello', {});

    expect(mockRegistry.updateChat).toHaveBeenCalledWith('123', {
      providerSessionId: expect.any(String),
      nativePath: '/tmp/claude-session.jsonl',
    });
  });

  it('passes hydrated project path through resumed OpenCode turns', async () => {
    mockRegistry.getChat.mockReturnValue({
      provider: 'opencode',
      projectPath: '/proj',
      providerSessionId: 'sess-3',
      model: 'openai/gpt-5',
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
    });

    await registry.runProviderTurn('123', 'continue', {});

    expect(mockOpencode.runTurn).toHaveBeenCalledWith({
      command: 'continue',
      providerSessionId: 'sess-3',
      chatId: '123',
      projectPath: '/proj',
      model: 'openai/gpt-5',
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
    });
  });

  it('preserves explicit runtime overrides over registry values', async () => {
    mockRegistry.getChat.mockReturnValue({
      provider: 'claude',
      projectPath: '/proj',
      providerSessionId: 'sess-2',
      model: 'opus',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    await registry.runProviderTurn('123', 'continue', {
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      thinkingMode: 'ultrathink',
    });

    expect(mockClaude.runClaudeTurn).toHaveBeenCalledWith({
      command: 'continue',
      providerSessionId: 'sess-2',
      chatId: '123',
      projectPath: '/proj',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      thinkingMode: 'ultrathink',
    });
  });
});
