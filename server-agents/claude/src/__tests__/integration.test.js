import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ClaudeAgentIntegration from '../index.js';

function createHost(root = '/tmp/garcon-claude-integration-test') {
  return {
    agentId: 'claude',
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

describe('ClaudeAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new ClaudeAgentIntegration(host);

    expect(ClaudeAgentIntegration.integrationId).toBe('claude');
    expect(ClaudeAgentIntegration.apiVersion).toBe(5);
    expect(integration.descriptor.id).toBe('claude');
    expect(integration.descriptor.requiresNativePathForProjectPathUpdate).toBe(false);
    expect(integration.projectPathUpdates).toBeDefined();
    expect(integration.transcriptSearch).toBeUndefined();
    expect(integration.forking).toMatchObject({
      fork: expect.any(Function),
      discard: expect.any(Function),
    });
    expect(integration.steering).toEqual({
      captureTarget: expect.any(Function),
      steer: expect.any(Function),
    });
    expect(integration.auth).toBeDefined();
    expect(integration.commands).toBeDefined();
    expect(integration.endpoints).toBeDefined();
    expect(integration.singleQuery).toBeDefined();
    expect(integration.settings.describe()).toEqual([
      expect.objectContaining({
        key: 'claudeThinkingMode',
        labelKey: 'thinking',
        options: [
          expect.objectContaining({
            value: 'auto',
            labelKey: 'automatic',
            descriptionKey: 'thinkingAutomatic',
          }),
          expect.objectContaining({
            value: 'on',
            labelKey: 'enabled',
            descriptionKey: 'thinkingEnabled',
          }),
          expect.objectContaining({
            value: 'off',
            labelKey: 'disabled',
            descriptionKey: 'thinkingDisabled',
          }),
        ],
      }),
    ]);
    expect(host.environment.get).not.toHaveBeenCalled();
  });

  it('exposes only Fable 5.1 under the fable selection', async () => {
    const integration = new ClaudeAgentIntegration(createHost());
    const catalog = await integration.catalog.snapshot({
      strict: false,
      signal: new AbortController().signal,
    });

    expect(catalog.models.filter(({ value }) => value.includes('fable'))).toEqual([
      {
        value: 'fable',
        label: 'Fable 5.1',
        supportsImages: true,
      },
    ]);
  });

  it('preserves version 1 settings and native-session migration envelopes', async () => {
    const integration = new ClaudeAgentIntegration(createHost());
    const signal = new AbortController().signal;

    expect(integration.settings.defaults()).toEqual({
      ownerId: 'claude',
      schemaVersion: 1,
      values: { claudeThinkingMode: 'auto' },
    });
    await expect(integration.migration.translateLegacyNativeSession({
      chatId: 'chat-1',
      projectPath: '/repo',
      model: 'sonnet',
      agentSessionId: 'session-1',
      legacyNativePath: '/tmp/claude-session.jsonl',
      legacyValues: { modelEndpointId: 'endpoint-1' },
      signal,
    })).resolves.toEqual({
      ownerId: 'claude',
      schemaVersion: 1,
      value: {
        path: '/tmp/claude-session.jsonl',
        agentSessionId: 'session-1',
        modelEndpointId: 'endpoint-1',
      },
    });
  });

  it('[TLV5-ADOPT.08-CLAUDE-NATIVE-UNIT-01] rejects incomplete selected records and recognized content payloads before retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-claude-native-import-'));
    const nativePath = join(root, 'session.jsonl');
    await writeFile(
      nativePath,
      `${JSON.stringify({ sessionId: 'session-1', type: 'user' })}\n`,
      'utf8',
    );
    const integration = new ClaudeAgentIntegration(createHost(root));
    const reference = nativeChat(integration, nativePath);

    try {
      await expect(importedRows(integration.nativeHistoryImport, reference)).rejects.toThrow();

      const malformedPartShapes = [
        ['null part', null],
        ['primitive part', 17],
        ['array part', []],
        ['part type missing', {}],
        ['part type empty', { type: '' }],
        ['part type non-string', { type: 17 }],
      ];
      const invalidParts = [
        ...['user', 'assistant'].flatMap((role) => malformedPartShapes.map(
          ([label, part]) => [`${role} ${label}`, role, part],
        )),
        ['user text missing', 'user', { type: 'text' }],
        ['user text non-string', 'user', { type: 'text', text: 17 }],
        ['assistant text missing', 'assistant', { type: 'text' }],
        ['assistant text non-string', 'assistant', { type: 'text', text: 17 }],
        ['thinking missing', 'assistant', { type: 'thinking' }],
        ['thinking non-string', 'assistant', { type: 'thinking', thinking: false }],
      ];
      const invalidContents = [
        ...invalidParts.map(([label, role, part]) => [label, role, [part]]),
        [
          'recognized part before malformed part',
          'assistant',
          [{ type: 'text', text: 'recognized assistant content' }, {}],
        ],
        [
          'malformed part before recognized part',
          'assistant',
          [{}, { type: 'text', text: 'recognized assistant content' }],
        ],
      ];
      const outcomes = [];
      for (const [label, role, content] of invalidContents) {
        await writeFile(nativePath, `${JSON.stringify({
          sessionId: 'session-1',
          type: role,
          uuid: 'invalid-part',
          timestamp: '2026-08-16T00:00:00.000Z',
          message: { role, content },
        })}\n`, 'utf8');
        try {
          await importedRows(integration.nativeHistoryImport, reference);
          outcomes.push([label, 'fulfilled']);
        } catch {
          outcomes.push([label, 'rejected']);
        }
      }

      const topLevelContents = [
        ['user', 'retained top-level user content'],
        ['assistant', 'retained top-level assistant content'],
      ];
      await writeFile(nativePath, `${topLevelContents.map(([role, content], index) => JSON.stringify({
        sessionId: 'session-1',
        type: role,
        uuid: `top-level-${role}`,
        timestamp: `2026-08-16T00:00:0${index}.000Z`,
        message: { role, content },
      })).join('\n')}\n`, 'utf8');
      await expect(importedRows(integration.nativeHistoryImport, reference)).resolves.toMatchObject([
        { message: { type: 'user-message', content: topLevelContents[0][1] } },
        { message: { type: 'assistant-message', content: topLevelContents[1][1] } },
      ]);

      await writeFile(nativePath, [
        JSON.stringify({
          sessionId: 'session-1',
          type: 'queue-operation',
          uuid: 'housekeeping',
          timestamp: '2026-08-16T00:00:00.000Z',
          operation: 'dequeue',
        }),
        JSON.stringify({
          sessionId: 'session-1',
          type: 'user',
          uuid: 'empty-user',
          timestamp: '2026-08-16T00:00:01.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '' },
              { type: 'future-housekeeping', payload: { retained: true } },
            ],
          },
        }),
        JSON.stringify({
          sessionId: 'session-1',
          type: 'assistant',
          uuid: 'empty-assistant',
          timestamp: '2026-08-16T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '' },
              { type: 'thinking', thinking: '' },
              { type: 'future-housekeeping', payload: { retained: true } },
            ],
          },
        }),
        ...['user', 'assistant'].map((role, index) => JSON.stringify({
          sessionId: 'session-1',
          type: role,
          uuid: `empty-${role}-array`,
          timestamp: `2026-08-16T00:00:0${index + 3}.000Z`,
          message: { role, content: [] },
        })),
      ].join('\n') + '\n', 'utf8');
      await expect(importedRows(integration.nativeHistoryImport, reference)).resolves.toEqual([]);

      await writeFile(nativePath, '', 'utf8');
      await expect(importedRows(integration.nativeHistoryImport, reference)).resolves.toEqual([]);
      expect(outcomes).toEqual(invalidContents.map(([label]) => [label, 'rejected']));
    } finally {
      await integration.lifecycle.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function nativeChat(integration, nativePath) {
  return {
    chatId: 'claude-native-import',
    agentId: 'claude',
    agentSessionId: 'session-1',
    projectPath: '/tmp',
    model: 'haiku',
    nativeSession: {
      ownerId: 'claude',
      schemaVersion: 1,
      value: { path: nativePath, agentSessionId: 'session-1' },
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
