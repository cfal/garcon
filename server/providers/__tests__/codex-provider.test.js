import { beforeEach, describe, expect, it, mock } from 'bun:test';

const startThreadMock = mock();
const resumeThreadMock = mock();
const findPathMock = mock();

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

mock.module('../../projects/codex.js', () => ({
  findCodexSessionFileBySessionId: findPathMock,
}));

import { CodexProvider } from '../codex.js';

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
    findPathMock.mockReset();
  });

  it('emits session-created once and resolves immediately when thread.id is available', async () => {
    const provider = new CodexProvider();
    const created = mock();
    provider.onSessionCreated(created);

    startThreadMock.mockImplementation(() => ({
      id: 'codex-session-1',
      runStreamed: mock(() => Promise.resolve({
        events: createEventStream([{ type: 'turn.completed' }]),
      })),
    }));
    findPathMock.mockImplementation(() => Promise.resolve('/tmp/codex-session-1.jsonl'));

    const started = await provider.startSession({
      chatId: 'chat-1',
      command: 'hello',
      projectPath: '/proj',
      model: 'gpt-5.4',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    expect(started).toEqual({
      providerSessionId: 'codex-session-1',
      nativePath: '/tmp/codex-session-1.jsonl',
    });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith('chat-1');
  });

  it('waits for streamed thread.started when thread.id is initially unavailable', async () => {
    const provider = new CodexProvider();
    const created = mock();
    provider.onSessionCreated(created);

    startThreadMock.mockImplementation(() => ({
      id: null,
      runStreamed: mock(() => Promise.resolve({
        events: createEventStream([
          { type: 'thread.started', thread_id: 'codex-session-2' },
          { type: 'turn.completed' },
        ]),
      })),
    }));
    findPathMock.mockImplementation(() => Promise.resolve('/tmp/codex-session-2.jsonl'));

    const started = await provider.startSession({
      chatId: 'chat-2',
      command: 'hello',
      projectPath: '/proj',
      model: 'gpt-5.4',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    expect(started).toEqual({
      providerSessionId: 'codex-session-2',
      nativePath: '/tmp/codex-session-2.jsonl',
    });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith('chat-2');
  });
});
