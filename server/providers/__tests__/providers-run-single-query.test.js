// Tests for ProviderRegistry.runSingleQuery routing.
// claude-cli.js and codex.js standalone exports still need mock.module()
// because runSingleQuery imports them at the module level.
// opencode is injected via constructor as an instance with a
// runSingleQuery method.

import { describe, it, expect, mock } from 'bun:test';

const claudeMock = mock(async () => 'claude-response');
const codexMock = mock(async () => 'codex-response');

mock.module('../claude-cli.js', () => ({
  runSingleQuery: claudeMock,
  ClaudeProvider: class { constructor() {} },
}));

mock.module('../codex.js', () => ({
  runSingleQuery: codexMock,
  CodexProvider: class { constructor() {} },
}));

// Mock the stateless loader imports that ProviderRegistry pulls in
mock.module('../loaders/claude-history-loader.js', () => ({
  getClaudePreviewFromNativePath: mock(() => Promise.resolve(null)),
  getClaudeSessionMessagesFromNativePath: mock(() => Promise.resolve([])),
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
const mockOpencode = { runSingleQuery: opencodeMock };

const mockRegistry = {
  getChat: mock(() => null),
  getChatByProviderSessionId: mock(() => null),
};

import { ProviderRegistry } from '../index.js';

const registry = new ProviderRegistry(mockRegistry, {}, {}, mockOpencode);

describe('providers registry runSingleQuery', () => {
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
