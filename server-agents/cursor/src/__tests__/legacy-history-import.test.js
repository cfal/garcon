import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import CursorAgentIntegration from '../index.js';
import { cursorAcpStoreDbPath } from '../agents/cursor/history-loader.js';
import { createCursorTranscriptSource } from '../agents/cursor/cursor-transcript-source.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe('Cursor history import', () => {
  it('[TLV5-ADOPT.07-CURSOR-UNIT-01] retries the same store after an unreadable legacy source', async () => {
    const cursorHome = await mkdtemp(join(tmpdir(), 'garcon-cursor-legacy-import-'));
    roots.push(cursorHome);
    const sessionId = `sacs-legacy-${crypto.randomUUID()}`;
    const storePath = cursorAcpStoreDbPath(sessionId, cursorHome);
    const sessionDirectory = dirname(storePath);
    const transcriptSource = createCursorTranscriptSource({ cursorHome });
    const integration = new CursorAgentIntegration(createHost(cursorHome), { transcriptSource });
    try {
      expect(integration.legacyHistoryImport).toBeDefined();
      expect(integration.legacyHistoryImport).not.toBeNull();
      if (!integration.legacyHistoryImport) return;
      const reference = chat(sessionId);
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);

      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(storePath, 'not a sqlite database', 'utf8');
      await expect(importedRows(integration.legacyHistoryImport, reference)).rejects.toThrow();

      await rm(storePath, { force: true });
      await createEmptyCursorStore(storePath);
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);
    } finally {
      await integration.lifecycle.stop();
    }
  });

  it('[TLV5-ADOPT.08-CURSOR-NATIVE-UNIT-01] distinguishes valid empty native history from selected-store failures', async () => {
    const cursorHome = await mkdtemp(join(tmpdir(), 'garcon-cursor-native-import-'));
    roots.push(cursorHome);
    const emptySessionId = `sacs-native-empty-${crypto.randomUUID()}`;
    const missingSessionId = `sacs-native-missing-${crypto.randomUUID()}`;
    const unreadableSessionId = `sacs-native-unreadable-${crypto.randomUUID()}`;
    await createEmptyCursorStore(cursorAcpStoreDbPath(emptySessionId, cursorHome));
    const unreadableStorePath = cursorAcpStoreDbPath(unreadableSessionId, cursorHome);
    await mkdir(dirname(unreadableStorePath), { recursive: true });
    await writeFile(unreadableStorePath, 'not a sqlite database', 'utf8');
    const transcriptSource = createCursorTranscriptSource({ cursorHome });
    const integration = new CursorAgentIntegration(createHost(cursorHome), { transcriptSource });

    try {
      expect(integration.nativeHistoryImport).not.toBeNull();
      const outcomes = await Promise.allSettled([
        importedRows(integration.nativeHistoryImport, chat(emptySessionId)),
        importedRows(integration.nativeHistoryImport, chat(missingSessionId)),
        importedRows(integration.nativeHistoryImport, chat(unreadableSessionId)),
      ]);

      expect(outcomes[0]).toEqual({ status: 'fulfilled', value: [] });
      expect(outcomes[1]?.status).toBe('rejected');
      expect(outcomes[2]?.status).toBe('rejected');
    } finally {
      await integration.lifecycle.stop();
    }
  });
});

async function createEmptyCursorStore(storePath) {
  await mkdir(dirname(storePath), { recursive: true });
  const database = new Database(storePath);
  try {
    database.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  } finally {
    database.close();
  }
}

function createHost(root) {
  const storageRoot = join(root, 'garcon-storage');
  return {
    agentId: 'cursor',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      rootDirectory: storageRoot,
      directory: async () => storageRoot,
      claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
  };
}

function chat(sessionId) {
  return {
    chatId: 'cursor-legacy-chat',
    agentId: 'cursor',
    agentSessionId: sessionId,
    projectPath: '/tmp',
    model: '',
    nativeSession: {
      ownerId: 'cursor',
      schemaVersion: 1,
      value: { path: `!cursor-acp:${sessionId}`, agentSessionId: sessionId },
    },
    carryOverRevision: '',
    nativeSeedReceipt: null,
    settings: { ownerId: 'cursor', schemaVersion: 1, values: {} },
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
