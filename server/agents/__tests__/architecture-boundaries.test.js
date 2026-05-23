import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') || path.endsWith('.js') ? [path] : [];
  });
}

describe('agent architecture boundaries', () => {
  test('keeps server/acp protocol-only', () => {
    for (const file of walk('server/acp')) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('common/chat-types');
      expect(source).not.toContain('server/agents');
      expect(source).not.toContain('../agents');
      expect(source).not.toContain('api-providers');
    }
  });

  test('keeps server/providers empty', () => {
    expect(walk('server/providers')).toEqual([]);
  });

  test('keeps agent converters and history loaders colocated with their owning agent', () => {
    expect(existsSync('server/agents/converters')).toBe(false);
    expect(existsSync('server/agents/loaders')).toBe(false);

    for (const root of ['server/agents', 'server/chats', 'server/routes', 'server/ws']) {
      for (const file of walk(root)) {
        if (file.endsWith('architecture-boundaries.test.js')) continue;
        const source = readFileSync(file, 'utf8');
        expect(source).not.toContain('agents/converters');
        expect(source).not.toContain('agents/loaders');
        expect(source).not.toContain('../converters/');
        expect(source).not.toContain('../loaders/');
      }
    }
  });

  test('does not keep the transitional adapter/plugin layer', () => {
    expect(existsSync('server/providers/provider-adapter.ts')).toBe(false);
    expect(existsSync('server/providers/provider-adapters.ts')).toBe(false);
    expect(existsSync('server/providers/agent-plugin.ts')).toBe(false);
    expect(existsSync('server/providers/agent-plugin-bridge.ts')).toBe(false);
  });

  test('keeps AgentRegistry out of API provider mutation ownership', () => {
    const source = readFileSync('server/agents/registry.ts', 'utf8');
    expect(source).not.toContain('createApiProvider(');
    expect(source).not.toContain('updateApiProvider(');
    expect(source).not.toContain('deleteApiProvider(');
    expect(source).not.toContain('testApiProvider(');
    expect(source).not.toContain('discoverApiProviderModels(');
  });

  test('keeps AgentRegistry as a facade over focused agent services', () => {
    expect(existsSync('server/agents/runtime-router.ts')).toBe(true);
    expect(existsSync('server/agents/event-bus.ts')).toBe(true);
    expect(existsSync('server/agents/session-settings-service.ts')).toBe(true);

    const source = readFileSync('server/agents/registry.ts', 'utf8');
    expect(source).toContain('new AgentRuntimeRouter');
    expect(source).toContain('new AgentEventBus');
    expect(source).toContain('new AgentSessionSettingsService');
    expect(source).not.toContain('resolveFileMentionsInCommand');
    expect(source).not.toContain('assertSameApiProviderBoundary');
    expect(source).not.toContain('#turnMetadataByChatId');
    expect(source).not.toContain('liveSessionSettingsPatch');
  });

  test('keeps shared agent contracts split from API provider templates', () => {
    expect(existsSync('common/providers.ts')).toBe(false);
    const source = readFileSync('common/agents.ts', 'utf8');
    expect(source).not.toContain('API_PROVIDER_TEMPLATE_IDS');
    expect(source).not.toContain('ApiProviderTemplateId');
  });

  test('composition root creates agents through the default agent suite', () => {
    const source = readFileSync('server/server.js', 'utf8');
    expect(source).toContain('const agentRegistry = new AgentRegistry');
    expect(source).toContain('createDefaultAgentSuite');
    expect(source).not.toContain('new CodexAppServerRuntime');
    expect(source).not.toContain('new ClaudeCliRuntime');
    expect(source).not.toContain('createCursorAgent(');
    expect(source).not.toContain('providerRegistry');
    expect(source).not.toContain('CursorRequestIdentityStore');
    expect(source).not.toContain('adapterToAgent');
  });

  test('generic chat and route modules do not import concrete agent internals', () => {
    const checkedRoots = ['server/chats', 'server/routes', 'server/ws'];
    const forbidden = [
      '../agents/claude',
      '../agents/pi',
      '../agents/codex',
      '../agents/cursor',
      '../agents/opencode',
      '../agents/amp',
      '../agents/factory',
      '../../agents/claude',
      '../../agents/pi',
      '../../agents/codex',
      '../../agents/cursor',
      '../../agents/opencode',
      '../../agents/amp',
      '../../agents/factory',
    ];

    for (const root of checkedRoots) {
      for (const file of walk(root)) {
        if (file.includes('__tests__')) continue;
        const source = readFileSync(file, 'utf8');
        for (const importPath of forbidden) {
          expect(source, `${file} imports ${importPath}`).not.toContain(importPath);
        }
      }
    }
  });

  test('server execution paths use AgentRegistry for runtime capabilities', () => {
    const files = [
      'server/routes/chats.ts',
      'server/ws/chat.ts',
      'server/chats/fork-chat.js',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('supportsFork as');
      expect(source).not.toContain('supportsImages as');
      expect(source).not.toContain('BUILTIN_AGENT_CAPABILITIES');
    }
  });

  test('does not use provider terminology for agent runtime base classes', () => {
    for (const file of walk('server/agents')) {
      if (file.includes('__tests__')) continue;
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('AbsProvider');
    }
  });

  test('chat store normalizes current agent fields without provider compatibility shims', () => {
    const source = readFileSync('server/chats/store.ts', 'utf8');
    expect(source).toContain('rawEntry.agentSessionId');
    expect(source).not.toMatch(/rawEntry\.provider(?:SessionId)?/);
    expect(source).not.toContain('...(rawEntry as Record<string, unknown>)');
  });

  test('keeps the public agent contract faceted without extra driver interfaces', () => {
    const source = readFileSync('server/agents/types.ts', 'utf8');
    expect(source).toContain('export interface AgentRuntime');
    expect(source).toContain('updateSessionSettings?');
    expect(source).toContain('export interface AgentTranscriptSource');
    expect(source).toContain('export interface AgentAuth');
    expect(source).toContain('export interface AgentCapabilities');
    expect(source).not.toMatch(/Agent(?:RuntimeModeControls|AuthDriver|CapabilityDriver)/);
    expect(source).not.toContain('setPermissionMode?');
    expect(source).not.toContain('setThinkingMode?');
    expect(source).not.toContain('setClaudeThinkingMode?');
    expect(source).not.toContain('setAmpAgentMode?');
  });
});
