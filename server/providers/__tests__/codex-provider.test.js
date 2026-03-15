import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const startThreadMock = mock();
const resumeThreadMock = mock();

mock.module('@openai/codex-sdk', () => ({
  Codex: class {
    startThread(options) {
      return startThreadMock(options);
    }

    resumeThread(providerSessionId, options) {
      return resumeThreadMock(providerSessionId, options);
    }
  },
}));

import { CODEX_SESSIONS_ROOT, CodexProvider } from '../codex.js';

function createEventStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('CodexProvider session startup', () => {
  beforeEach(() => {
    startThreadMock.mockReset();
    resumeThreadMock.mockReset();
  });

  it('emits session-created once and resolves immediately when thread.id is available', async () => {
    const provider = new CodexProvider();
    const created = mock();
    provider.onSessionCreated(created);
    const sessionId = `codex-session-${randomUUID()}`;
    const testRoot = path.join(CODEX_SESSIONS_ROOT, `__test-${sessionId}`);
    const nestedDir = path.join(testRoot, 'nested');
    const nativePath = path.join(nestedDir, `rollout-123-${sessionId}.jsonl`);

    startThreadMock.mockImplementation(() => ({
      id: sessionId,
      runStreamed: mock(() => Promise.resolve({
        events: createEventStream([{ type: 'turn.completed' }]),
      })),
    }));
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(nativePath, '{}\n');

    try {
      const started = await provider.startSession({
        chatId: 'chat-1',
        command: 'hello',
        projectPath: '/proj',
        model: 'gpt-5.4',
        permissionMode: 'default',
        thinkingMode: 'none',
      });

      expect(started).toEqual({
        providerSessionId: sessionId,
        nativePath,
      });
      expect(created).toHaveBeenCalledTimes(1);
      expect(created).toHaveBeenCalledWith('chat-1');
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });

  it('waits for streamed thread.started when thread.id is initially unavailable', async () => {
    const provider = new CodexProvider();
    const created = mock();
    provider.onSessionCreated(created);
    const sessionId = `codex-session-${randomUUID()}`;
    const testRoot = path.join(CODEX_SESSIONS_ROOT, `__test-${sessionId}`);
    const nestedDir = path.join(testRoot, 'nested');
    const nativePath = path.join(nestedDir, `rollout-123-${sessionId}.jsonl`);

    startThreadMock.mockImplementation(() => ({
      id: null,
      runStreamed: mock(() => Promise.resolve({
        events: createEventStream([
          { type: 'thread.started', thread_id: sessionId },
          { type: 'turn.completed' },
        ]),
      })),
    }));
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(nativePath, '{}\n');

    try {
      const started = await provider.startSession({
        chatId: 'chat-2',
        command: 'hello',
        projectPath: '/proj',
        model: 'gpt-5.4',
        permissionMode: 'default',
        thinkingMode: 'none',
      });

      expect(started).toEqual({
        providerSessionId: sessionId,
        nativePath,
      });
      expect(created).toHaveBeenCalledTimes(1);
      expect(created).toHaveBeenCalledWith('chat-2');
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });

  it('resumes a previously completed session and emits assistant messages', async () => {
    const provider = new CodexProvider();
    const messages = mock();
    provider.onMessages(messages);
    const sessionId = `codex-session-${randomUUID()}`;
    const testRoot = path.join(CODEX_SESSIONS_ROOT, `__test-${sessionId}`);
    const nestedDir = path.join(testRoot, 'nested');
    const nativePath = path.join(nestedDir, `rollout-123-${sessionId}.jsonl`);

    startThreadMock.mockImplementation(() => ({
      id: sessionId,
      runStreamed: mock(() => Promise.resolve({
        events: createEventStream([{ type: 'turn.completed' }]),
      })),
    }));
    resumeThreadMock.mockImplementation(() => ({
      id: sessionId,
      runStreamed: mock(() => Promise.resolve({
        events: createEventStream([
          {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'resumed output' },
          },
          { type: 'turn.completed' },
        ]),
      })),
    }));

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(nativePath, '{}\n');

    try {
      const started = await provider.startSession({
        chatId: 'chat-3',
        command: 'hello',
        projectPath: '/proj',
        model: 'gpt-5.4',
        permissionMode: 'default',
        thinkingMode: 'none',
      });

      await provider.runTurn({
        chatId: 'chat-3',
        providerSessionId: started.providerSessionId,
        command: 'resume',
        projectPath: '/proj',
        model: 'gpt-5.4',
        permissionMode: 'default',
        thinkingMode: 'none',
      });

      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0][0]).toBe('chat-3');
      expect(messages.mock.calls[0][1]).toHaveLength(1);
      expect(messages.mock.calls[0][1][0].content).toBe('resumed output');
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });

  it('resumes a previously aborted session instead of exiting immediately', async () => {
    const provider = new CodexProvider();
    const messages = mock();
    provider.onMessages(messages);
    const sessionId = `codex-session-${randomUUID()}`;
    const testRoot = path.join(CODEX_SESSIONS_ROOT, `__test-${sessionId}`);
    const nestedDir = path.join(testRoot, 'nested');
    const nativePath = path.join(nestedDir, `rollout-123-${sessionId}.jsonl`);

    startThreadMock.mockImplementation(() => ({
      id: sessionId,
      runStreamed: mock(() => Promise.resolve({
        events: createEventStream([{ type: 'turn.completed' }]),
      })),
    }));
    resumeThreadMock.mockImplementation(() => ({
      id: sessionId,
      runStreamed: mock(() => Promise.resolve({
        events: createEventStream([
          {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'output after abort' },
          },
          { type: 'turn.completed' },
        ]),
      })),
    }));

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(nativePath, '{}\n');

    try {
      const started = await provider.startSession({
        chatId: 'chat-4',
        command: 'hello',
        projectPath: '/proj',
        model: 'gpt-5.4',
        permissionMode: 'default',
        thinkingMode: 'none',
      });

      expect(provider.abort(started.providerSessionId)).toBeTrue();

      await provider.runTurn({
        chatId: 'chat-4',
        providerSessionId: started.providerSessionId,
        command: 'resume',
        projectPath: '/proj',
        model: 'gpt-5.4',
        permissionMode: 'default',
        thinkingMode: 'none',
      });

      expect(messages).toHaveBeenCalledTimes(1);
      expect(messages.mock.calls[0][1]).toHaveLength(1);
      expect(messages.mock.calls[0][1][0].content).toBe('output after abort');
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });
});
