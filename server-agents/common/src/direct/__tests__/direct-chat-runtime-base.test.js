import { afterEach, describe, expect, it } from 'bun:test';
import { DirectChatRuntimeBase } from '../direct-chat-runtime-base.ts';
import {
  createTestDirectSessionStore,
  removeTestDirectSessionStores,
} from './session-store-fixture.ts';

const runtimes = [];

class CapturingDirectRuntime extends DirectChatRuntimeBase {
  captured = [];
  responses = [];

  constructor(sessions = createTestDirectSessionStore(), overrides = {}) {
    super({
      runtimeLabel: 'Capturing Direct',
      defaultModel: 'default-model',
      sessions,
      ...overrides,
    });
    runtimes.push(this);
  }

  buildUserMessage(command) {
    return { role: 'user', content: command };
  }

  buildAssistantMessage(content) {
    return { role: 'assistant', content };
  }

  async streamSession(session) {
    this.captured.push({
      thinkingMode: session.thinkingMode,
      messages: structuredClone(session.messages),
    });
    return {
      content: await (this.responses.shift() ?? 'OK'),
      checkpoint: null,
    };
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function capturingOperation(runId) {
  const events = [];
  const terminal = deferred();
  return {
    events,
    operation: {
      runId,
      publish(event) {
        events.push(event);
        if (event.type === 'run-ended') terminal.resolve();
      },
    },
    terminal: terminal.promise,
  };
}

function startRequest(overrides = {}) {
  return {
    chatId: 'chat-1',
    command: 'first message',
    projectPath: '/tmp/project',
    model: 'selected-model',
    permissionMode: 'default',
    thinkingMode: 'high',
    claudeThinkingMode: 'auto',
    operation: { runId: 'run-start', publish() {} },
    ...overrides,
  };
}

function resumeRequest(agentSessionId, overrides = {}) {
  return {
    chatId: 'chat-1',
    agentSessionId,
    command: 'next message',
    projectPath: '/tmp/project',
    model: 'selected-model',
    permissionMode: 'default',
    thinkingMode: 'low',
    claudeThinkingMode: 'auto',
    operation: { runId: 'run-resume', publish() {} },
    ...overrides,
  };
}

describe('DirectChatRuntimeBase reasoning effort lifecycle', () => {
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.shutdown();
    await removeTestDirectSessionStores();
  });

  it('captures effort before initial provider work', async () => {
    const runtime = new CapturingDirectRuntime();
    const observed = capturingOperation('run-high');

    await runtime.startSession(startRequest({ thinkingMode: 'high', operation: observed.operation }));
    await observed.terminal;

    expect(runtime.captured).toEqual([{
      thinkingMode: 'high',
      messages: [{ role: 'user', content: 'first message' }],
    }]);
  });

  it('replaces effort on every in-memory resume, including Default', async () => {
    const runtime = new CapturingDirectRuntime();
    const first = capturingOperation('run-first');
    const started = await runtime.startSession(startRequest({
      thinkingMode: 'high',
      operation: first.operation,
    }));
    await first.terminal;

    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'second message',
      thinkingMode: 'low',
      nativeSession: started.nativeSession,
      operation: { runId: 'run-second', publish() {} },
    }));
    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'third message',
      thinkingMode: 'none',
      nativeSession: started.nativeSession,
      operation: { runId: 'run-third', publish() {} },
    }));

    expect(runtime.captured.map((entry) => entry.thinkingMode)).toEqual([
      'high',
      'low',
      'none',
    ]);
    expect(runtime.captured[2].messages).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'second message' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'third message' },
    ]);
  });

  it('uses the current resume effort with persisted native history', async () => {
    const sessionId = '10000000-0000-4000-8000-000000000001';
    const sessions = createTestDirectSessionStore();
    await sessions.create({
      sessionId,
      runId: 'run-first',
      content: 'first message',
      attachments: [],
    });
    await sessions.appendAssistant({
      sessionId,
      runId: 'run-first',
      content: 'first response',
    });

    const runtime = new CapturingDirectRuntime(sessions);
    await runtime.runTurn(resumeRequest(sessionId, {
      command: 'resumed message',
      thinkingMode: 'max',
      nativeSession: sessions.nativeReference(sessionId),
    }));

    expect(runtime.captured).toEqual([{
      thinkingMode: 'max',
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first response' },
        { role: 'user', content: 'resumed message' },
      ],
    }]);
  });

  it('normalizes invalid untyped effort to Default', async () => {
    const runtime = new CapturingDirectRuntime();
    const observed = capturingOperation('run-invalid');

    await runtime.startSession(startRequest({
      thinkingMode: 'invalid',
      operation: observed.operation,
    }));
    await observed.terminal;

    expect(runtime.captured[0].thinkingMode).toBe('none');
  });

  it('retains the first seeded input when bounding provider request history', async () => {
    const sessions = createTestDirectSessionStore();
    const runtime = new CapturingDirectRuntime(sessions, { maxMessagesPerSession: 3 });
    const first = capturingOperation('run-first');
    const started = await runtime.startSession(startRequest({
      command: '<carried-context>seed</carried-context>\n\nfirst message',
      operation: first.operation,
    }));
    await first.terminal;

    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'second message',
      nativeSession: started.nativeSession,
      operation: { runId: 'run-second', publish() {} },
    }));
    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'third message',
      nativeSession: started.nativeSession,
      operation: { runId: 'run-third', publish() {} },
    }));

    expect(runtime.captured.at(-1)?.messages).toEqual([
      { role: 'user', content: '<carried-context>seed</carried-context>\n\nfirst message' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'third message' },
    ]);
    expect((await sessions.load(started.agentSessionId)).records).toHaveLength(6);
  });

  it('publishes no assistant row when durable assistant storage fails', async () => {
    const sessions = createTestDirectSessionStore();
    sessions.appendAssistant = async () => {
      throw new Error('injected append failure');
    };
    const runtime = new CapturingDirectRuntime(sessions);
    const observed = capturingOperation('run-failure');

    await runtime.startSession(startRequest({ operation: observed.operation }));
    await observed.terminal;

    expect(observed.events).toEqual([{
      type: 'run-ended',
      runId: 'run-failure',
      outcome: 'failed',
      error: {
        code: 'TRANSCRIPT_UNAVAILABLE',
        message: 'This conversation cannot be loaded because its Direct history is unavailable.',
      },
    }]);
  });

  it('[TLV5-L05.03-DIRECT-UNIT-01] admits a successor immediately after best-effort abort and preserves late output', async () => {
    const runtime = new CapturingDirectRuntime();
    const firstResponse = deferred();
    runtime.responses.push(firstResponse.promise, 'second response');
    const first = capturingOperation('run-first');
    const second = capturingOperation('run-second');

    const started = await runtime.startSession(startRequest({ operation: first.operation }));
    expect(runtime.abort(started.agentSessionId)).toBe(true);
    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'second message',
      nativeSession: started.nativeSession,
      operation: second.operation,
    }));
    firstResponse.resolve('late first response');
    await first.terminal;

    expect([
      second.events[0].rows[0].message.content,
      first.events[0].rows[0].message.content,
    ]).toEqual([
      'second response',
      'late first response',
    ]);
  });

  it('publishes a delayed response through the request that started it', async () => {
    const runtime = new CapturingDirectRuntime();
    const firstResponse = deferred();
    runtime.responses.push(firstResponse.promise, 'second response');
    const first = capturingOperation('run-1');
    const second = capturingOperation('run-2');

    const started = await runtime.startSession(startRequest({
      operation: first.operation,
    }));
    expect(runtime.abort(started.agentSessionId)).toBe(true);
    await runtime.runTurn(resumeRequest(started.agentSessionId, {
      command: 'second message',
      nativeSession: started.nativeSession,
      operation: second.operation,
    }));
    await second.terminal;

    firstResponse.resolve('late first response');
    await first.terminal;

    expect(first.events.map((event) => event.type)).toEqual(['rows', 'run-ended']);
    expect(first.events[0].rows.map((row) => row.message.content)).toEqual([
      'late first response',
    ]);
    expect(first.events[1]).toMatchObject({ type: 'run-ended', runId: 'run-1' });
    expect(second.events.map((event) => event.type)).toEqual(['rows', 'run-ended']);
    expect(second.events[0].rows.map((row) => row.message.content)).toEqual([
      'second response',
    ]);
    expect(second.events[1]).toMatchObject({ type: 'run-ended', runId: 'run-2' });
  });
});
