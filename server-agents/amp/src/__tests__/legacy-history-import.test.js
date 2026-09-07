import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AmpAgentIntegration from '../index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Amp history import', () => {
  it('[TLV5-ADOPT.07-AMP-READ-FAILURE-UNIT-01] retries the same source after a provider read failure', async () => {
    const root = await temporaryRoot();
    const binary = join(root, 'amp-unreadable-legacy-fixture');
    const integration = new AmpAgentIntegration(createHost(root, binary));
    const reference = chat(integration, { agentSessionId: 'repairable-amp-thread' });

    try {
      await expect(importedRows(integration.legacyHistoryImport, chat(integration))).resolves
        .toEqual([]);
      await expect(importedRows(integration.legacyHistoryImport, reference)).rejects.toThrow();

      await writeFile(binary, `#!${process.execPath}
console.log(JSON.stringify({ messages: [] }));
`, 'utf8');
      await chmod(binary, 0o755);
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);
    } finally {
      await integration.lifecycle.stop();
    }
  });

  it('[TLV5-ADOPT.07-AMP-UNIT-01] retries the same source after invalid content parts', async () => {
    const root = await temporaryRoot();
    const binary = join(root, 'amp-legacy-fixture');
    const integration = new AmpAgentIntegration(createHost(root, binary));
    try {
      expect(integration.legacyHistoryImport).toBeDefined();
      expect(integration.legacyHistoryImport).not.toBeNull();
      await expect(importedRows(integration.legacyHistoryImport, chat(integration))).resolves
        .toEqual([]);
      const reference = chat(integration, { agentSessionId: 'repairable-amp-thread' });
      const invalidContents = [
        ['user text missing', 'user', [{ type: 'text' }]],
        ['user empty part type', 'user', [{ type: '' }]],
        ['assistant empty part type', 'assistant', [{ type: '' }]],
        [
          'recognized part before empty part type',
          'assistant',
          [{ type: 'text', text: 'recognized assistant content' }, { type: '' }],
        ],
        [
          'empty part type before recognized part',
          'assistant',
          [{ type: '' }, { type: 'text', text: 'recognized assistant content' }],
        ],
      ];
      const outcomes = [];
      for (const [label, role, content] of invalidContents) {
        await writeAmpFixture(binary, {
          created: '2026-08-16T00:00:00.000Z',
          messages: [{ role, messageId: 1, content }],
        });
        try {
          await importedRows(integration.legacyHistoryImport, reference);
          outcomes.push([label, 'fulfilled']);
        } catch {
          outcomes.push([label, 'rejected']);
        }
      }

      await writeAmpFixture(binary, {
        created: '2026-08-16T00:00:00.000Z',
        messages: [
          { role: 'user', messageId: 1, content: [{ type: 'future-housekeeping' }] },
          { role: 'assistant', messageId: 2, content: [{ type: 'future-housekeeping' }] },
          { role: 'user', messageId: 3, content: [] },
          { role: 'assistant', messageId: 4, content: [] },
        ],
      });
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);
      expect(outcomes).toEqual(invalidContents.map(([label]) => [label, 'rejected']));
    } finally {
      await integration.lifecycle.stop();
    }
  });

  it('[TLV5-ADOPT.08-AMP-NATIVE-UNIT-01] distinguishes valid empty native history from selected-thread failures', async () => {
    const root = await temporaryRoot();
    const binary = join(root, 'amp-fixture');
    await writeFile(binary, `#!${process.execPath}
const threadId = process.argv.at(-1);
if (threadId === 'missing-thread') {
  console.error('thread not found');
  process.exit(1);
}
if (threadId === 'malformed-thread') {
  console.log('{');
  process.exit(0);
}
console.log(JSON.stringify({ messages: [] }));
`, 'utf8');
    await chmod(binary, 0o755);
    const integration = new AmpAgentIntegration(createHost(root, binary));
    try {
      const [empty, missing, malformed] = await Promise.allSettled([
        importedRows(integration.nativeHistoryImport, chat(integration, {
          agentSessionId: 'empty-thread',
          nativeSession: nativeSession('empty-thread'),
        })),
        importedRows(integration.nativeHistoryImport, chat(integration, {
          agentSessionId: 'missing-thread',
          nativeSession: nativeSession('missing-thread'),
        })),
        importedRows(integration.nativeHistoryImport, chat(integration, {
          agentSessionId: 'malformed-thread',
          nativeSession: nativeSession('malformed-thread'),
        })),
      ]);

      expect(empty).toEqual({ status: 'fulfilled', value: [] });
      expect(missing.status).toBe('rejected');
      expect(malformed.status).toBe('rejected');

      const repairableReference = chat(integration, {
        agentSessionId: 'repairable-thread',
        nativeSession: nativeSession('repairable-thread'),
      });
      const invalidContents = [
        ['user text missing', 'user', [{ type: 'text' }]],
        ['user empty part type', 'user', [{ type: '' }]],
        ['assistant empty part type', 'assistant', [{ type: '' }]],
        [
          'recognized part before empty part type',
          'assistant',
          [{ type: 'text', text: 'recognized assistant content' }, { type: '' }],
        ],
        [
          'empty part type before recognized part',
          'assistant',
          [{ type: '' }, { type: 'text', text: 'recognized assistant content' }],
        ],
      ];
      const outcomes = [];
      for (const [label, role, content] of invalidContents) {
        await writeAmpFixture(binary, {
          created: '2026-08-16T00:00:00.000Z',
          messages: [{ role, messageId: 1, content }],
        });
        try {
          await importedRows(integration.nativeHistoryImport, repairableReference);
          outcomes.push([label, 'fulfilled']);
        } catch {
          outcomes.push([label, 'rejected']);
        }
      }

      await writeAmpFixture(binary, {
        created: '2026-08-16T00:00:00.000Z',
        messages: [
          { role: 'user', messageId: 1, content: [{ type: 'future-housekeeping' }] },
          { role: 'assistant', messageId: 2, content: [{ type: 'future-housekeeping' }] },
          { role: 'user', messageId: 3, content: [] },
          { role: 'assistant', messageId: 4, content: [] },
        ],
      });
      await expect(importedRows(integration.nativeHistoryImport, repairableReference))
        .resolves.toEqual([]);
      expect(outcomes).toEqual(invalidContents.map(([label]) => [label, 'rejected']));
    } finally {
      await integration.lifecycle.stop();
    }
  });
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'garcon-amp-history-import-'));
  roots.push(root);
  return root;
}

async function writeAmpFixture(binary, threadExport) {
  await writeFile(binary, `#!${process.execPath}
console.log(JSON.stringify(${JSON.stringify(threadExport)}));
`, 'utf8');
  await chmod(binary, 0o755);
}

function createHost(root, binary) {
  return {
    agentId: 'amp',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      rootDirectory: root,
      directory: async () => root,
      claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
    },
    environment: {
      get: (name) => name === 'AMP_BINARY' ? binary : undefined,
    },
    apiProviders: { resolveCredential: async () => null },
  };
}

function nativeSession(agentSessionId) {
  return {
    ownerId: 'amp',
    schemaVersion: 1,
    value: { path: `!amp:${agentSessionId}`, agentSessionId },
  };
}

function chat(integration, overrides = {}) {
  return {
    chatId: 'amp-legacy-chat',
    agentId: 'amp',
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

async function importedRows(importer, chatReference) {
  const rows = [];
  for await (const batch of importer.load({
    chat: chatReference,
    signal: new AbortController().signal,
  })) rows.push(...batch);
  return rows;
}
