import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  getPiPreviewFromSessionPath,
  loadPiChatMessages,
} from '../loaders/pi-history-loader.js';

let tempRoot;

function assistantMessage(content, timestamp = 1767225602000) {
  return {
    role: 'assistant',
    content,
    provider: 'anthropic',
    model: 'claude-test',
    api: 'anthropic-messages',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}

async function writeJsonl(fileName, entries) {
  const sessionPath = path.join(tempRoot, fileName);
  await fs.writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return sessionPath;
}

describe('Pi history loader', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-pi-history-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it('normalizes persisted Pi session messages into canonical chat messages', async () => {
    const sessionPath = await writeJsonl('session.jsonl', [
      { type: 'session', version: 3, id: 'session-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/project' },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'hello pi', timestamp: 1767225601000 },
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: assistantMessage([
          { type: 'thinking', thinking: 'looking' },
          { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' } },
          { type: 'text', text: 'done' },
        ]),
      },
      {
        type: 'message',
        id: 'tool-1-result',
        parentId: 'assistant-1',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tool-1',
          toolName: 'bash',
          content: { stdout: '/tmp/project' },
          isError: false,
          timestamp: 1767225603000,
        },
      },
    ]);

    const messages = await loadPiChatMessages(sessionPath);

    expect(messages.map((message) => message.type)).toEqual([
      'user-message',
      'thinking',
      'bash-tool-use',
      'assistant-message',
      'tool-result',
    ]);
    expect(messages[0].content).toBe('hello pi');
    expect(messages[2].command).toBe('pwd');
    expect(messages[4].content).toEqual({ stdout: '/tmp/project' });
  });

  it('loads the active Pi branch rather than flattening sibling branches', async () => {
    const sessionPath = await writeJsonl('branches.jsonl', [
      { type: 'session', version: 3, id: 'session-branches', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/project' },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'question', timestamp: 1767225601000 },
      },
      {
        type: 'message',
        id: 'assistant-old',
        parentId: 'user-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: assistantMessage([{ type: 'text', text: 'old branch' }], 1767225602000),
      },
      {
        type: 'message',
        id: 'assistant-new',
        parentId: 'user-1',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: assistantMessage([{ type: 'text', text: 'new branch' }], 1767225603000),
      },
    ]);

    const messages = await loadPiChatMessages(sessionPath);

    expect(messages.map((message) => message.content)).toEqual(['question', 'new branch']);
  });

  it('builds previews from normalized Pi history', async () => {
    const sessionPath = await writeJsonl('preview.jsonl', [
      { type: 'session', version: 3, id: 'session-preview', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/project' },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'first prompt', timestamp: 1767225601000 },
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: assistantMessage([{ type: 'text', text: 'last answer' }], 1767225602000),
      },
    ]);

    await expect(getPiPreviewFromSessionPath(sessionPath)).resolves.toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      firstMessage: 'first prompt',
      lastMessage: 'last answer',
      lastActivity: '2026-01-01T00:00:02.000Z',
    });
  });
});
