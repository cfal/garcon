import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import FactoryAgentIntegration from '../index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Factory history import', () => {
  it('[TLV5-ADOPT.07-FACTORY-READ-FAILURE-UNIT-01] retries the same source after an unreadable legacy file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-factory-legacy-read-failure-'));
    roots.push(root);
    const integration = new FactoryAgentIntegration(createHost(root));
    const unreadablePath = join(root, 'sessions', 'unreadable.jsonl');
    await mkdir(unreadablePath, { recursive: true });
    const reference = chat(integration, {
      agentSessionId: 'factory-unreadable',
      nativeSession: {
        ownerId: 'factory',
        schemaVersion: 1,
        value: { path: unreadablePath, agentSessionId: 'factory-unreadable' },
      },
    });

    try {
      await expect(importedRows(integration.legacyHistoryImport, chat(integration))).resolves
        .toEqual([]);
      await expect(importedRows(integration.legacyHistoryImport, reference)).rejects.toThrow();

      await rm(unreadablePath, { recursive: true, force: true });
      await writeFile(unreadablePath, '', 'utf8');
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);
    } finally {
      await integration.lifecycle.stop();
    }
  });

  it('[TLV5-ADOPT.07-FACTORY-UNIT-01] rejects invalid events and recognized content payloads before retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-factory-legacy-import-'));
    roots.push(root);
    const integration = new FactoryAgentIntegration(createHost(root));
    const invalidPath = join(root, 'sessions', 'invalid.jsonl');
    await mkdir(dirname(invalidPath), { recursive: true });
    await writeFile(invalidPath, '{"type":"message"}\n', 'utf8');

    try {
      expect(integration.legacyHistoryImport).toBeDefined();
      expect(integration.legacyHistoryImport).not.toBeNull();
      await expect(importedRows(integration.legacyHistoryImport, chat(integration))).resolves
        .toEqual([]);
      const reference = chat(integration, {
        agentSessionId: 'factory-invalid',
        nativeSession: {
          ownerId: 'factory',
          schemaVersion: 1,
          value: { path: invalidPath, agentSessionId: 'factory-invalid' },
        },
      });
      await expect(importedRows(integration.legacyHistoryImport, reference)).rejects.toThrow();

      const invalidParts = [
        ['text missing', { type: 'text' }],
        ['text non-string', { type: 'text', text: 17 }],
        ['thinking missing', { type: 'thinking' }],
        ['thinking non-string', { type: 'thinking', thinking: false }],
      ];
      const partOutcomes = [];
      for (const [label, part] of invalidParts) {
        await writeFile(invalidPath, `${JSON.stringify({
          type: 'message',
          timestamp: '2026-08-16T00:00:00.000Z',
          message: { role: 'assistant', content: [part] },
        })}\n`, 'utf8');
        try {
          await importedRows(integration.legacyHistoryImport, reference);
          partOutcomes.push([label, 'fulfilled']);
        } catch {
          partOutcomes.push([label, 'rejected']);
        }
      }

      await writeFile(invalidPath, [
        JSON.stringify({
          type: 'session_start',
          id: 'factory-invalid',
          timestamp: '2026-08-16T00:00:00.000Z',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-08-16T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '' },
              { type: 'thinking', thinking: '' },
            ],
          },
        }),
      ].join('\n') + '\n', 'utf8');
      await expect(importedRows(integration.legacyHistoryImport, reference))
        .resolves.toEqual(expect.any(Array));

      await writeFile(invalidPath, '', 'utf8');
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);
      expect(partOutcomes).toEqual(invalidParts.map(([label]) => [label, 'rejected']));
    } finally {
      await integration.lifecycle.stop();
    }
  });

  it('[TLV5-ADOPT.08-FACTORY-NATIVE-UNIT-01] rejects selected-source failures and incomplete content payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-factory-native-import-'));
    roots.push(root);
    const emptyPath = join(root, 'sessions', 'empty.jsonl');
    const missingPath = join(root, 'sessions', 'missing.jsonl');
    const malformedPath = join(root, 'sessions', 'malformed.jsonl');
    const incompletePath = join(root, 'sessions', 'incomplete.jsonl');
    await mkdir(dirname(emptyPath), { recursive: true });
    await writeFile(emptyPath, '', 'utf8');
    await writeFile(malformedPath, '{"type":\n', 'utf8');
    await writeFile(incompletePath, '{"type":"message"}\n', 'utf8');
    const integration = new FactoryAgentIntegration(createHost(root));

    try {
      const outcomes = await Promise.allSettled([
        importedRows(
          integration.nativeHistoryImport,
          nativeChat(integration, 'factory-empty', emptyPath),
        ),
        importedRows(
          integration.nativeHistoryImport,
          nativeChat(integration, 'factory-missing', missingPath),
        ),
        importedRows(
          integration.nativeHistoryImport,
          nativeChat(integration, 'factory-malformed', malformedPath),
        ),
      ]);

      expect(outcomes[0]).toEqual({ status: 'fulfilled', value: [] });
      expect(outcomes[1]?.status).toBe('rejected');
      expect(outcomes[2]?.status).toBe('rejected');

      const incompleteReference = nativeChat(
        integration,
        'factory-incomplete',
        incompletePath,
      );
      await expect(importedRows(integration.nativeHistoryImport, incompleteReference))
        .rejects.toThrow();

      const invalidParts = [
        ['text missing', { type: 'text' }],
        ['text non-string', { type: 'text', text: 17 }],
        ['thinking missing', { type: 'thinking' }],
        ['thinking non-string', { type: 'thinking', thinking: false }],
      ];
      const partOutcomes = [];
      for (const [label, part] of invalidParts) {
        await writeFile(incompletePath, `${JSON.stringify({
          type: 'message',
          timestamp: '2026-08-16T00:00:00.000Z',
          message: { role: 'assistant', content: [part] },
        })}\n`, 'utf8');
        try {
          await importedRows(integration.nativeHistoryImport, incompleteReference);
          partOutcomes.push([label, 'fulfilled']);
        } catch {
          partOutcomes.push([label, 'rejected']);
        }
      }

      await writeFile(incompletePath, [
        JSON.stringify({
          type: 'session_start',
          id: 'factory-incomplete',
          timestamp: '2026-08-16T00:00:00.000Z',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-08-16T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '' },
              { type: 'thinking', thinking: '' },
            ],
          },
        }),
      ].join('\n') + '\n', 'utf8');
      await expect(importedRows(integration.nativeHistoryImport, incompleteReference))
        .resolves.toEqual(expect.any(Array));

      await writeFile(incompletePath, '', 'utf8');
      await expect(importedRows(integration.nativeHistoryImport, incompleteReference))
        .resolves.toEqual([]);
      expect(partOutcomes).toEqual(invalidParts.map(([label]) => [label, 'rejected']));
    } finally {
      await integration.lifecycle.stop();
    }
  });
});

function createHost(root) {
  return {
    agentId: 'factory',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      rootDirectory: root,
      directory: async () => root,
      claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
  };
}

function chat(integration, overrides = {}) {
  return {
    chatId: 'factory-legacy-chat',
    agentId: 'factory',
    agentSessionId: null,
    projectPath: '/tmp',
    model: '',
    nativeSession: null,
    carryOverRevision: '',
    nativeSeedReceipt: null,
    settings: integration.settings.defaults(),
    ...overrides,
  };
}

function nativeChat(integration, agentSessionId, nativePath) {
  return chat(integration, {
    agentSessionId,
    nativeSession: {
      ownerId: 'factory',
      schemaVersion: 1,
      value: { path: nativePath, agentSessionId },
    },
  });
}

async function importedRows(importer, chatReference) {
  const rows = [];
  for await (const batch of importer.load({
    chat: chatReference,
    signal: new AbortController().signal,
  })) rows.push(...batch);
  return rows;
}
