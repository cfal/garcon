import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CodexAgentIntegration from '../index.js';

function createHost(root = '/tmp/garcon-codex-integration-test') {
  return {
    agentId: 'codex',
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    storage: {
      rootDirectory: root,
      directory: mock(() => Promise.resolve(join(root, 'search'))),
      claimLegacyWorkspaceDirectory: mock(() => Promise.resolve({ moved: 0, skipped: 0 })),
    },
    environment: { get: mock(() => undefined) },
    apiProviders: { resolveCredential: mock(() => Promise.resolve(null)) },
  };
}

describe('CodexAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new CodexAgentIntegration(host);

    expect(CodexAgentIntegration.integrationId).toBe('codex');
    expect(CodexAgentIntegration.apiVersion).toBe(5);
    expect(integration.descriptor.id).toBe('codex');
    expect(integration.steering?.steer).toBeDefined();
    expect(integration.goals?.submitControl).toBeDefined();
    expect(integration.compaction?.compact).toBeDefined();
    expect(integration).not.toHaveProperty('permissionDecisions');
    expect(integration.projectPathUpdates).toBeNull();
    expect(integration.transcriptSearch).toBeUndefined();
    expect(integration.forking).toMatchObject({
      fork: expect.any(Function),
      discard: expect.any(Function),
    });
    expect(integration.auth).toBeDefined();
    expect(integration.commands).toBeDefined();
    expect(integration.endpoints).toBeDefined();
    expect(integration.singleQuery).toBeDefined();
    expect(host.environment.get).not.toHaveBeenCalled();
  });

  it('preserves version 1 settings and native-session migration envelopes', async () => {
    const integration = new CodexAgentIntegration(createHost());
    const signal = new AbortController().signal;

    expect(integration.settings.defaults()).toEqual({
      ownerId: 'codex',
      schemaVersion: 1,
      values: {},
    });
    await expect(integration.migration.translateLegacyNativeSession({
      chatId: 'chat-1',
      projectPath: '/repo',
      model: 'gpt-5.4',
      agentSessionId: 'thread-1',
      legacyNativePath: '/tmp/codex-session.jsonl',
      legacyValues: { modelEndpointId: 'endpoint-1' },
      signal,
    })).resolves.toEqual({
      ownerId: 'codex',
      schemaVersion: 1,
      value: {
        path: '/tmp/codex-session.jsonl',
        agentSessionId: 'thread-1',
        modelEndpointId: 'endpoint-1',
      },
    });
  });

  it('[TLV5-ADOPT.08-CODEX-NATIVE-UNIT-01] rejects incomplete selected records and recognized content payloads before retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-codex-native-import-'));
    const nativePath = join(root, 'rollout.jsonl');
    const sessionMetadata = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-08-16T00:00:00.000Z',
      payload: { id: 'thread-1', history_mode: 'legacy' },
    });
    const incompleteMessage = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-08-16T00:00:01.000Z',
      payload: { type: 'message', role: 'assistant' },
    });
    await writeFile(nativePath, `${sessionMetadata}\n${incompleteMessage}\n`, 'utf8');
    const integration = new CodexAgentIntegration(createHost(root));
    const reference = nativeChat(integration, nativePath);

    try {
      await expect(importedRows(integration.nativeHistoryImport, reference)).rejects.toThrow();

      const invalidParts = [
        ['user input_text missing', 'user', { type: 'input_text' }],
        ['user input_text non-string', 'user', { type: 'input_text', text: 17 }],
        ['developer input_text missing', 'developer', { type: 'input_text' }],
        ['developer input_text non-string', 'developer', { type: 'input_text', text: 17 }],
        ['output_text missing', 'assistant', { type: 'output_text' }],
        ['output_text non-string', 'assistant', { type: 'output_text', text: false }],
        ['text missing', 'assistant', { type: 'text' }],
        ['text non-string', 'assistant', { type: 'text', text: null }],
      ];
      const outcomes = [];
      for (const [label, role, part] of invalidParts) {
        const message = JSON.stringify({
          type: 'response_item',
          timestamp: '2026-08-16T00:00:01.000Z',
          payload: { type: 'message', role, content: [part] },
        });
        await writeFile(nativePath, `${sessionMetadata}\n${message}\n`, 'utf8');
        try {
          await importedRows(integration.nativeHistoryImport, reference);
          outcomes.push([label, 'fulfilled']);
        } catch {
          outcomes.push([label, 'rejected']);
        }
      }

      const validEmptyMessages = [
        ['user', { type: 'input_text', text: '' }],
        ['developer', { type: 'input_text', text: '' }],
        ['assistant', { type: 'output_text', text: '' }],
        ['assistant', { type: 'text', text: '' }],
      ].map(([role, part], index) => JSON.stringify({
        type: 'response_item',
        timestamp: `2026-08-16T00:00:0${index + 1}.000Z`,
        payload: { type: 'message', role, content: [part] },
      }));
      await writeFile(
        nativePath,
        `${sessionMetadata}\n${validEmptyMessages.join('\n')}\n`,
        'utf8',
      );
      await expect(importedRows(integration.nativeHistoryImport, reference)).resolves.toEqual([]);

      await writeFile(nativePath, `${sessionMetadata}\n`, 'utf8');
      await expect(importedRows(integration.nativeHistoryImport, reference)).resolves.toEqual([]);
      expect(outcomes).toEqual(invalidParts.map(([label]) => [label, 'rejected']));
    } finally {
      await integration.lifecycle.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function nativeChat(integration, nativePath) {
  return {
    chatId: 'codex-native-import',
    agentId: 'codex',
    agentSessionId: 'thread-1',
    projectPath: '/tmp',
    model: 'gpt-5.4',
    nativeSession: {
      ownerId: 'codex',
      schemaVersion: 1,
      value: { path: nativePath, agentSessionId: 'thread-1' },
    },
    carryOverRevision: '',
    nativeSeedReceipt: null,
    settings: integration.settings.defaults(),
  };
}

async function importedRows(importer, chat) {
  const rows = [];
  for await (const batch of importer.load({
    chat,
    signal: new AbortController().signal,
  })) rows.push(...batch);
  return rows;
}
