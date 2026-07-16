import { describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRegistry } from '../../registry.ts';
import { migrateDirectNativePaths } from '../native-path-migration.ts';
import { createDirectOpenAiChatAgent } from '../openai-chat.ts';

function directEntry(overrides = {}) {
  return {
    agentId: 'direct-openai-compatible',
    agentSessionId: 'session-1',
    nativePath: '!direct-openai-compatible:session-1',
    projectPath: '/repo',
    tags: [],
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'none',
    claudeThinkingMode: 'auto',
    ampAgentMode: 'smart',
    ...overrides,
  };
}

describe('Direct native path migration', () => {
  it('converts through the production AgentRegistry transcript resolver', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-direct-migration-'));
    try {
      const endpoint = {
        id: 'chat_endpoint',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.test/v1',
        apiKey: '',
        capabilities: { chatCompletions: true, responses: false },
        defaultModel: 'example-model',
        models: [{ value: 'example-model', label: 'Example Model' }],
        supportsImages: false,
        modelDiscovery: 'openai-models',
      };
      const provider = { id: 'acme', label: 'Acme', endpoints: [endpoint] };
      const apiProviders = {
        list: () => [provider],
        getEndpoint: (endpointId) => endpointId === endpoint.id
          ? { apiProvider: provider, endpoint }
          : null,
      };
      const direct = directEntry({ modelEndpointId: endpoint.id });
      const snapshot = { version: 2, sessions: { direct } };
      const saveRegistry = mock(async () => {});
      const registry = {
        getRegistry: () => snapshot,
        saveRegistry,
      };
      const nativePath = path.join(
        workspaceDir,
        'openai-compatible-sessions',
        endpoint.id,
        'session-1.jsonl',
      );
      await fs.mkdir(path.dirname(nativePath), { recursive: true });
      await fs.writeFile(nativePath, `${JSON.stringify({ role: 'user', content: 'legacy' })}\n`);
      const agents = new AgentRegistry({
        registry,
        agents: [createDirectOpenAiChatAgent(apiProviders, workspaceDir)],
        endpointResolver: {},
      });

      const result = await migrateDirectNativePaths(
        registry,
        (session) => agents.resolveNativePath(session),
      );

      expect(result).toEqual({ converted: 1, skipped: 0, failed: 0 });
      expect(direct.nativePath).toBe(nativePath);
      expect(saveRegistry).toHaveBeenCalledWith(snapshot);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('converts only resolvable artificial Direct paths and saves once', async () => {
    const direct = directEntry();
    const alreadyReal = directEntry({
      agentId: 'direct-anthropic-compatible',
      agentSessionId: 'session-2',
      nativePath: '/workspace/anthropic-compatible-sessions/acme/session-2.jsonl',
    });
    const other = directEntry({
      agentId: 'opencode',
      nativePath: '!opencode:session-3',
    });
    const snapshot = {
      version: 2,
      sessions: { direct, alreadyReal, other },
    };
    const saveRegistry = mock(async () => {});
    const registry = { getRegistry: () => snapshot, saveRegistry };

    const result = await migrateDirectNativePaths(
      registry,
      async (session) => session === direct ? '/workspace/direct/session-1.jsonl' : null,
    );

    expect(result).toEqual({ converted: 1, skipped: 0, failed: 0 });
    expect(direct.nativePath).toBe('/workspace/direct/session-1.jsonl');
    expect(alreadyReal.nativePath).toContain('session-2.jsonl');
    expect(other.nativePath).toBe('!opencode:session-3');
    expect(saveRegistry).toHaveBeenCalledTimes(1);
    expect(saveRegistry).toHaveBeenCalledWith(snapshot);

    await migrateDirectNativePaths(registry, async () => null);
    expect(saveRegistry).toHaveBeenCalledTimes(1);
  });

  it('preserves unresolved artificial Direct paths', async () => {
    const direct = directEntry();
    const snapshot = { version: 2, sessions: { direct } };
    const saveRegistry = mock(async () => {});

    const result = await migrateDirectNativePaths(
      { getRegistry: () => snapshot, saveRegistry },
      async () => null,
    );

    expect(result).toEqual({ converted: 0, skipped: 1, failed: 0 });
    expect(direct.nativePath).toBe('!direct-openai-compatible:session-1');
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('continues after a resolver failure and saves later conversions', async () => {
    const failed = directEntry({ agentSessionId: 'failed' });
    const converted = directEntry({
      agentId: 'direct-openai-responses-compatible',
      agentSessionId: 'converted',
      nativePath: '!direct-openai-responses-compatible:converted',
    });
    const snapshot = { version: 2, sessions: { failed, converted } };
    const saveRegistry = mock(async () => {});

    const result = await migrateDirectNativePaths(
      { getRegistry: () => snapshot, saveRegistry },
      async (session) => {
        if (session === failed) throw new Error('permission denied');
        return '/workspace/direct/converted.jsonl';
      },
    );

    expect(result).toEqual({ converted: 1, skipped: 0, failed: 1 });
    expect(failed.nativePath).toBe('!direct-openai-compatible:session-1');
    expect(converted.nativePath).toBe('/workspace/direct/converted.jsonl');
    expect(saveRegistry).toHaveBeenCalledTimes(1);
  });
});
