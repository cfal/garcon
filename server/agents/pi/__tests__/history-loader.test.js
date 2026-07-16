import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  getPiPreviewFromSessionPath,
  loadPiChatMessages,
} from '../history-loader.js';
import { loadPiSearchTranscript } from '../search-transcript-source.js';
import { createPiAgent } from '../index.ts';

const originalPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
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

async function loadSearchMessages(sessionPath, batchSize = 2) {
  const messages = [];
  for await (const batch of loadPiSearchTranscript(
    { kind: 'pi-jsonl', nativePath: sessionPath },
    {
      signal: new AbortController().signal,
      batchSize,
      scratchDirectory: path.join(tempRoot, 'search-scratch'),
    },
  )) messages.push(...batch);
  return messages;
}

describe('Pi history loader', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-pi-history-'));
    process.env.PI_CODING_AGENT_SESSION_DIR = tempRoot;
  });

  afterEach(async () => {
    if (originalPiSessionDir === undefined) {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    } else {
      process.env.PI_CODING_AGENT_SESSION_DIR = originalPiSessionDir;
    }
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
    expect(await loadSearchMessages(sessionPath)).toEqual(messages);
  });

  it('matches the active leaf when malformed entries omit parent ids', async () => {
    const sessionPath = await writeJsonl('missing-parents.jsonl', [
      { type: 'session', version: 3, id: 'session-missing-parents', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/project' },
      {
        type: 'message',
        id: 'detached-message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'detached content', timestamp: 1767225601000 },
      },
      {
        type: 'message',
        id: 'active-leaf',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: assistantMessage([{ type: 'text', text: 'active content' }], 1767225602000),
      },
    ]);

    expect(await loadSearchMessages(sessionPath, 1)).toEqual(await loadPiChatMessages(sessionPath));
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

  it('loads persisted Pi history through the registered agent transcript source', async () => {
    const sessionPath = await writeJsonl('2026-01-01T00-00-00-000Z_session-agent-real.jsonl', [
      { type: 'session', version: 3, id: 'session-agent-real', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/project' },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'restore real path', timestamp: 1767225601000 },
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: assistantMessage([{ type: 'text', text: 'restored answer' }], 1767225602000),
      },
    ]);
    const agent = createPiAgent({});

    const messages = await agent.transcript.loadMessages({
      agentId: 'pi',
      agentSessionId: 'session-agent-real',
      nativePath: sessionPath,
      projectPath: '/tmp/project',
    });
    const preview = await agent.transcript.getPreview({
      agentId: 'pi',
      agentSessionId: 'session-agent-real',
      nativePath: sessionPath,
      projectPath: '/tmp/project',
    });

    expect(messages.map((message) => message.content)).toEqual(['restore real path', 'restored answer']);
    expect(preview).toMatchObject({
      firstMessage: 'restore real path',
      lastMessage: 'restored answer',
    });
  });

  it('resolves artificial Pi native paths by session id through the agent transcript source', async () => {
    await writeJsonl('2026-01-01T00-00-00-000Z_session-agent-artificial.jsonl', [
      { type: 'session', version: 3, id: 'session-agent-artificial', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/project' },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'restore artificial path', timestamp: 1767225601000 },
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: assistantMessage([{ type: 'text', text: 'resolved by id' }], 1767225602000),
      },
    ]);
    const agent = createPiAgent({});

    const messages = await agent.transcript.loadMessages({
      agentId: 'pi',
      agentSessionId: 'session-agent-artificial',
      nativePath: '!pi:session-agent-artificial',
      projectPath: '/tmp/project',
    });

    expect(messages.map((message) => message.content)).toEqual(['restore artificial path', 'resolved by id']);
  });
});
