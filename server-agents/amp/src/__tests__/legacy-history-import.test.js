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
  it('[TLV5-ADOPT.07-AMP-UNIT-01] retries the same source after an invalid user record', async () => {
    const root = await temporaryRoot();
    const binary = join(root, 'amp-legacy-fixture');
    const integration = new AmpAgentIntegration(createHost(root, binary));
    try {
      expect(integration.legacyHistoryImport).toBeDefined();
      expect(integration.legacyHistoryImport).not.toBeNull();
      await expect(importedRows(integration.legacyHistoryImport, chat(integration))).resolves
        .toEqual([]);
      const reference = chat(integration, { agentSessionId: 'repairable-amp-thread' });
      await writeFile(binary, `#!${process.execPath}
console.log(JSON.stringify({
  created: '2026-08-16T00:00:00.000Z',
  messages: [{ role: 'user', messageId: 1, content: [{ type: 'text' }] }],
}));
`, 'utf8');
      await chmod(binary, 0o755);
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
