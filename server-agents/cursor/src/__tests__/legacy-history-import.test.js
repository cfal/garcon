import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import CursorAgentIntegration from '../index.js';
import {
  cursorAcpStoreDbPath,
  cursorStreamJsonStoreDbPath,
} from '../agents/cursor/history-loader.js';
import { createCursorTranscriptSource } from '../agents/cursor/cursor-transcript-source.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe('Cursor history import', () => {
  it('[TLV5-ADOPT.07-CURSOR-READ-FAILURE-UNIT-01] retries the same store after an unreadable legacy source', async () => {
    const cursorHome = await mkdtemp(join(tmpdir(), 'garcon-cursor-legacy-read-failure-'));
    roots.push(cursorHome);
    const sessionId = `sacs-legacy-read-failure-${crypto.randomUUID()}`;
    const storePath = cursorAcpStoreDbPath(sessionId, cursorHome);
    const transcriptSource = createCursorTranscriptSource({ cursorHome });
    const integration = new CursorAgentIntegration(createHost(cursorHome), { transcriptSource });
    const reference = chat(sessionId);

    try {
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);

      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(storePath, 'not a sqlite database', 'utf8');
      await expect(importedRows(integration.legacyHistoryImport, reference)).rejects.toThrow();

      await rm(storePath, { force: true });
      await createEmptyCursorStore(storePath);
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);
    } finally {
      await integration.lifecycle.stop();
    }
  });

  it('[TLV5-ADOPT.07-CURSOR-UNIT-01] retries the same store after an invalid user record', async () => {
    const cursorHome = await mkdtemp(join(tmpdir(), 'garcon-cursor-legacy-import-'));
    roots.push(cursorHome);
    const sessionId = `sacs-legacy-${crypto.randomUUID()}`;
    const storePath = cursorAcpStoreDbPath(sessionId, cursorHome);
    const transcriptSource = createCursorTranscriptSource({ cursorHome });
    const integration = new CursorAgentIntegration(createHost(cursorHome), { transcriptSource });
    try {
      expect(integration.legacyHistoryImport).toBeDefined();
      expect(integration.legacyHistoryImport).not.toBeNull();
      if (!integration.legacyHistoryImport) return;
      const reference = chat(sessionId);
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);

      await createEmptyCursorStore(storePath);
      writeCursorBlob(storePath, {
        role: 'user',
        content: [{ type: 'text' }],
      });
      await expect(importedRows(integration.legacyHistoryImport, reference)).rejects.toThrow();

      clearCursorStore(storePath);
      await expect(importedRows(integration.legacyHistoryImport, reference)).resolves.toEqual([]);
    } finally {
      await integration.lifecycle.stop();
    }
  });

  it('[TLV5-ADOPT.11-CURSOR-PREFERRED-UNIT-01] rejects an invalid preferred store before using the fallback and retries after repair', async () => {
    const cursorHome = await mkdtemp(join(tmpdir(), 'garcon-cursor-discovery-import-'));
    roots.push(cursorHome);
    const sessionId = `sacs-legacy-discovery-${crypto.randomUUID()}`;
    const preferredStorePath = cursorAcpStoreDbPath(sessionId, cursorHome);
    const fallbackStorePath = cursorStreamJsonStoreDbPath(sessionId, '/tmp', cursorHome);
    await createEmptyCursorStore(fallbackStorePath);
    await mkdir(dirname(preferredStorePath), { recursive: true });
    await symlink(join(cursorHome, 'missing-store.db'), preferredStorePath);
    const transcriptSource = createCursorTranscriptSource({ cursorHome });
    const integration = new CursorAgentIntegration(createHost(cursorHome), { transcriptSource });

    try {
      await expect(importedRows(integration.legacyHistoryImport, chat(sessionId)))
        .rejects.toThrow();

      await unlink(preferredStorePath);
      await expect(importedRows(integration.legacyHistoryImport, chat(sessionId)))
        .resolves.toEqual([]);
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
    const incompleteSessionId = `sacs-native-incomplete-${crypto.randomUUID()}`;
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

      const incompleteStorePath = cursorAcpStoreDbPath(incompleteSessionId, cursorHome);
      await createEmptyCursorStore(incompleteStorePath);
      writeCursorBlob(incompleteStorePath, {
        role: 'user',
        content: [{ type: 'text' }],
      });
      const incompleteReference = chat(incompleteSessionId);
      await expect(importedRows(integration.nativeHistoryImport, incompleteReference))
        .rejects.toThrow();

      clearCursorStore(incompleteStorePath);
      await expect(importedRows(integration.nativeHistoryImport, incompleteReference))
        .resolves.toEqual([]);
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

function writeCursorBlob(storePath, content) {
  const database = new Database(storePath);
  try {
    database.query('INSERT INTO blobs (id, data) VALUES (?, ?)')
      .run('invalid-message', Buffer.from(JSON.stringify(content)));
  } finally {
    database.close();
  }
}

function clearCursorStore(storePath) {
  const database = new Database(storePath);
  try {
    database.exec('DELETE FROM blobs');
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
