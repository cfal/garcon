import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'bun:sqlite';

import {
  cursorProjectHash,
  cursorStoreDbPath,
  getCursorPreviewFromSessionId,
  loadCursorChatMessagesBySessionId,
  normalizeCursorBlobs,
} from '../loaders/cursor-history-loader.js';

let tempRoot;

describe('Cursor history loader', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cursor-history-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('builds project-scoped store paths and rejects unsafe session ids', () => {
    expect(cursorProjectHash('/tmp/project')).toHaveLength(32);
    expect(cursorStoreDbPath('session-1', '/tmp/project', tempRoot))
      .toBe(path.join(tempRoot, 'chats', cursorProjectHash('/tmp/project'), 'session-1', 'store.db'));
    expect(() => cursorStoreDbPath('../session', '/tmp/project', tempRoot)).toThrow('Invalid Cursor session id');
  });

  it('normalizes Cursor blobs into canonical chat messages', () => {
    const messages = normalizeCursorBlobs([
      {
        id: 'user-1',
        rowid: 1,
        sequence: 1,
        content: {
          role: 'user',
          timestamp: '2026-05-22T01:00:00.000Z',
          content: [
            { type: 'text', text: '<user_query>Hello Cursor</user_query>' },
            { type: 'user_info', text: '<user_info>internal</user_info>' },
          ],
        },
      },
      {
        id: 'assistant-1',
        rowid: 2,
        sequence: 2,
        content: {
          role: 'assistant',
          timestamp: '2026-05-22T01:00:01.000Z',
          content: [
            { type: 'reasoning', text: 'Inspecting files' },
            {
              type: 'tool-call',
              toolName: 'ApplyPatch',
              toolCallId: 'tool-1',
              args: JSON.stringify({ path: 'src/app.ts', patch: '*** Begin Patch' }),
            },
            { type: 'text', text: 'Patched the file.' },
          ],
        },
      },
      {
        id: 'tool-result-1',
        rowid: 3,
        sequence: 3,
        content: {
          role: 'tool',
          timestamp: '2026-05-22T01:00:02.000Z',
          providerOptions: { cursor: { highLevelToolCallResult: { toolCallId: 'tool-1' } } },
          content: [{ type: 'tool-result', result: '{"ok":true}' }],
        },
      },
    ]);

    expect(messages.map((message) => message.type)).toEqual([
      'user-message',
      'thinking',
      'apply-patch-tool-use',
      'assistant-message',
      'tool-result',
    ]);
    expect(messages[0].content).toBe('Hello Cursor');
    expect(messages[2].patch).toBe('*** Begin Patch');
    expect(messages[4].content).toEqual({ ok: true });
  });

  it('unwraps user queries when Cursor prefixes them with timestamp metadata', () => {
    const messages = normalizeCursorBlobs([
      {
        id: 'user-1',
        rowid: 1,
        sequence: 1,
        content: {
          role: 'user',
          timestamp: '2026-05-22T01:00:00.000Z',
          content: [
            { type: 'text', text: '<system_reminder>Ask mode is active.</system_reminder>' },
            {
              type: 'text',
              text: '<timestamp>Friday, May 22, 2026, 9:31 AM (UTC)</timestamp>\n<user_query>\nhi\n</user_query>',
            },
          ],
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('user-message');
    expect(messages[0].content).toBe('hi');
  });

  it('keeps the user query when Cursor combines metadata and query tags in one part', () => {
    const messages = normalizeCursorBlobs([
      {
        id: 'user-1',
        rowid: 1,
        sequence: 1,
        content: {
          role: 'user',
          timestamp: '2026-05-22T01:00:00.000Z',
          content: [
            {
              type: 'text',
              text: '<system_reminder>Ask mode is active.</system_reminder>\n<timestamp>Friday, May 22, 2026, 9:31 AM (UTC)</timestamp>\n<user_query>\nhi\n</user_query>',
            },
          ],
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('user-message');
    expect(messages[0].content).toBe('hi');
  });

  it('normalizes Cursor Glob and Read tool results from high-level metadata', () => {
    const messages = normalizeCursorBlobs([
      {
        id: 'assistant-tools',
        rowid: 1,
        sequence: 1,
        content: {
          role: 'assistant',
          timestamp: '2026-05-22T01:00:00.000Z',
          content: [
            {
              type: 'tool-call',
              toolName: 'Glob',
              toolCallId: 'functions.Glob:0',
              args: { glob_pattern: 'contracts/**/daml.yaml' },
            },
            {
              type: 'tool-call',
              toolName: 'Read',
              toolCallId: 'functions.Read:1',
              args: { path: '/repo/contracts/ccip/core/daml.yaml' },
            },
          ],
        },
      },
      {
        id: 'glob-result',
        rowid: 2,
        sequence: 2,
        content: {
          role: 'tool',
          timestamp: '2026-05-22T01:00:01.000Z',
          providerOptions: {
            cursor: {
              highLevelToolCallResult: {
                output: {
                  success: {
                    files: ['./contracts/ccip/core/daml.yaml', './contracts/ccip/runtime/daml.yaml'],
                    totalFiles: 2,
                  },
                },
              },
            },
          },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'functions.Glob:0',
              toolName: 'Glob',
              result: 'Result of search in "" (total 2 files):\n- ./contracts/ccip/core/daml.yaml\n- ./contracts/ccip/runtime/daml.yaml\n',
            },
          ],
        },
      },
      {
        id: 'read-result',
        rowid: 3,
        sequence: 3,
        content: {
          role: 'tool',
          timestamp: '2026-05-22T01:00:02.000Z',
          providerOptions: {
            cursor: {
              highLevelToolCallResult: {
                output: {
                  success: {
                    content: 'sdk-version: 3.4.11\n',
                    totalLines: 1,
                    fileSize: 24,
                    path: '/repo/contracts/ccip/core/daml.yaml',
                    readRange: { startLine: 1, endLine: 1 },
                  },
                },
              },
            },
          },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'functions.Read:1',
              toolName: 'Read',
              result: '     1|sdk-version: 3.4.11\n',
            },
          ],
        },
      },
    ]);

    expect(messages.map((message) => message.type)).toEqual([
      'glob-tool-use',
      'read-tool-use',
      'tool-result',
      'tool-result',
    ]);
    expect(messages[0].pattern).toBe('contracts/**/daml.yaml');
    expect(messages[1].filePath).toBe('/repo/contracts/ccip/core/daml.yaml');
    expect(messages[2].content).toEqual({
      filenames: ['./contracts/ccip/core/daml.yaml', './contracts/ccip/runtime/daml.yaml'],
      numFiles: 2,
    });
    expect(messages[3].content).toEqual({
      content: 'sdk-version: 3.4.11\n',
      totalLines: 1,
      fileSize: 24,
      path: '/repo/contracts/ccip/core/daml.yaml',
      readRange: { startLine: 1, endLine: 1 },
    });
  });

  it('loads Cursor store.db blobs and builds previews', async () => {
    const sessionId = 'session-db';
    const projectPath = '/tmp/project';
    const storeDbPath = cursorStoreDbPath(sessionId, projectPath, tempRoot);
    await fs.mkdir(path.dirname(storeDbPath), { recursive: true });

    const db = new Database(storeDbPath);
    try {
      db.query('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)').run();
      db.query('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
        'user_blob',
        Buffer.from(JSON.stringify({
          role: 'user',
          timestamp: '2026-05-22T02:00:00.000Z',
          content: '<user_query>First prompt</user_query>',
        })),
      );
      db.query('INSERT INTO blobs (id, data) VALUES (?, ?)').run(
        'assistant_blob',
        Buffer.from(JSON.stringify({
          role: 'assistant',
          timestamp: '2026-05-22T02:00:01.000Z',
          content: 'Final reply',
        })),
      );
    } finally {
      db.close();
    }

    const messages = await loadCursorChatMessagesBySessionId(sessionId, projectPath, tempRoot);
    expect(messages.map((message) => message.type)).toEqual(['user-message', 'assistant-message']);
    expect(messages[0].content).toBe('First prompt');

    await expect(getCursorPreviewFromSessionId(sessionId, projectPath, tempRoot)).resolves.toEqual({
      createdAt: '2026-05-22T02:00:00.000Z',
      firstMessage: 'First prompt',
      lastActivity: '2026-05-22T02:00:01.000Z',
      lastMessage: 'Final reply',
    });
  });
});
