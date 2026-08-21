import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';
import { openCodeSessionStatusChange } from '../sse-events.js';

function createEventStream() {
  const events = [{
    payload: { id: 'event-connected', type: 'server.connected', properties: {} },
  }];
  const waiters = [];
  const promptRequestsByPart = new Map();
  const promptRequestsByMessage = new Map();
  let closed = false;
  const observe = (event) => {
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part;
      const request = promptRequestsByPart.get(part?.metadata?.garcon_operation_part_id ?? part?.id);
      if (request && typeof part?.messageID === 'string') {
        promptRequestsByMessage.set(part.messageID, request);
      }
      return;
    }
    const info = event.type === 'message.updated' ? event.properties?.info : null;
    if (typeof info?.time?.completed === 'number') {
      const request = promptRequestsByMessage.get(info.parentID);
      if (request) setImmediate(() => request.resolve({ data: { info, parts: [] } }));
    }
  };
  return {
    push(event) {
      events.push({ directory: '/repo', payload: event });
      for (const resolve of waiters.splice(0)) resolve();
      observe(event);
    },
    prompt(input, options) {
      return new Promise((resolve, reject) => {
        promptRequestsByPart.set(input.parts[0].id, { resolve });
        const abort = () => reject(options.signal.reason ?? new Error('aborted'));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    },
    close() {
      closed = true;
      for (const resolve of waiters.splice(0)) resolve();
    },
    async *stream() {
      while (!closed || events.length > 0) {
        if (events.length > 0) {
          yield events.shift();
          continue;
        }
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
  };
}

function createRuntime(sessionIds) {
  const eventStream = createEventStream();
  const promptAsync = mock(() => Promise.resolve({}));
  const prompt = mock((...args) => {
    void promptAsync(...args);
    return eventStream.prompt(...args);
  });
  const runtime = new OpenCodeRuntime({
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: mock(() => Promise.resolve({ stream: eventStream.stream() })) },
        session: {
          create: mock(() => Promise.resolve({ data: { id: sessionIds.shift() } })),
          prompt,
          promptAsync,
          abort: mock(() => Promise.resolve({ data: true })),
        },
      },
      server: { close: mock(() => undefined) },
    })),
  });
  return { eventStream, promptAsync, runtime };
}

function operation(runId, events) {
  return { runId, publish: (event) => events.push(event) };
}

function pushStatus(eventStream, sessionId, status) {
  eventStream.push({
    id: `event-status-${Math.random().toString(36).slice(2)}`,
    type: 'session.status',
    properties: { sessionID: sessionId, status },
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

function retryEvents(events) {
  return events.filter((event) => event.type === 'retry-status');
}

describe('OpenCode session status', () => {
  it('publishes retry detail for the running turn and clears it when the stream resumes', async () => {
    const { eventStream, runtime } = createRuntime(['session-1']);
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });

    pushStatus(eventStream, 'session-1', {
      type: 'retry',
      attempt: 2,
      message: 'Provider is overloaded',
      next: Date.parse('2026-08-21T20:23:00.000Z'),
    });
    await waitFor(() => retryEvents(events).length === 1);

    expect(retryEvents(events)[0]).toEqual({
      type: 'retry-status',
      runId: 'run-a',
      retry: {
        attempt: 2,
        message: 'Provider is overloaded',
        nextAttemptAt: '2026-08-21T20:23:00.000Z',
      },
    });

    pushStatus(eventStream, 'session-1', { type: 'busy' });
    await waitFor(() => retryEvents(events).length === 2);

    expect(retryEvents(events)[1]).toEqual({
      type: 'retry-status',
      runId: 'run-a',
      retry: null,
    });

    eventStream.close();
    await runtime.shutdown();
  });

  it('ignores status for foreign sessions and for sessions without a running turn', async () => {
    const { eventStream, promptAsync, runtime } = createRuntime(['session-1']);
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });

    pushStatus(eventStream, 'session-foreign', {
      type: 'retry',
      attempt: 1,
      message: 'not ours',
      next: 1,
    });

    const partId = promptAsync.mock.calls[0][0].parts[0].id;
    eventStream.push({
      id: 'event-01',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: partId, messageID: 'user-a', type: 'text', text: 'first' },
      },
    });
    eventStream.push({
      id: 'event-02',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: {
          id: 'assistant-a',
          role: 'assistant',
          parentID: 'user-a',
          finish: 'stop',
          time: { completed: 1 },
        },
      },
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));

    pushStatus(eventStream, 'session-1', {
      type: 'retry',
      attempt: 1,
      message: 'after terminal',
      next: 1,
    });
    eventStream.push({ id: 'event-noop', type: 'server.heartbeat', properties: {} });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));

    expect(retryEvents(events)).toEqual([]);
    eventStream.close();
    await runtime.shutdown();
  });
});

describe('openCodeSessionStatusChange', () => {
  it('reads the typed retry arm', () => {
    expect(openCodeSessionStatusChange({
      type: 'session.status',
      properties: {
        sessionID: 's',
        status: { type: 'retry', attempt: 1, message: ' overloaded ', next: 1000 },
      },
    })).toEqual({
      kind: 'retry',
      attempt: 1,
      message: 'overloaded',
      nextAttemptAt: '1970-01-01T00:00:01.000Z',
    });
  });

  it('maps busy and idle to a clear and rejects malformed payloads', () => {
    const clear = { kind: 'clear' };
    expect(openCodeSessionStatusChange({
      type: 'session.status',
      properties: { sessionID: 's', status: { type: 'busy' } },
    })).toEqual(clear);
    expect(openCodeSessionStatusChange({
      type: 'session.status',
      properties: { sessionID: 's', status: { type: 'idle' } },
    })).toEqual(clear);
    expect(openCodeSessionStatusChange({
      type: 'session.status',
      properties: { sessionID: 's', status: { type: 'retry', attempt: 1, message: '   ', next: 1 } },
    })).toBeNull();
    expect(openCodeSessionStatusChange({
      type: 'session.status',
      properties: { sessionID: 's', status: 'retry' },
    })).toBeNull();
    expect(openCodeSessionStatusChange({
      type: 'message.updated',
      properties: { sessionID: 's', status: { type: 'retry' } },
    })).toBeNull();
  });

  it('omits an unusable next timestamp instead of dropping the retry', () => {
    expect(openCodeSessionStatusChange({
      type: 'session.status',
      properties: {
        sessionID: 's',
        status: { type: 'retry', attempt: 0, message: 'quota exhausted', next: Number.NaN },
      },
    })).toEqual({
      kind: 'retry',
      attempt: 0,
      message: 'quota exhausted',
      nextAttemptAt: null,
    });
  });
});
