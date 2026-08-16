import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

function createEventStream() {
  const events = [{
    payload: { id: 'event-connected', type: 'server.connected', properties: {} },
  }];
  const waiters = [];
  const promptRequestsByPart = new Map();
  const promptRequestsByMessage = new Map();
  let closed = false;
  const resolvePrompt = (info) => {
    const request = promptRequestsByMessage.get(info.parentID);
    if (request) setImmediate(() => request.resolve({ data: { info, parts: [] } }));
  };
  const observe = (event, completePrompt) => {
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part;
      const operationPartId = part?.metadata?.garcon_operation_part_id ?? part?.id;
      let request = promptRequestsByPart.get(operationPartId);
      if (!request && (part?.type === 'compaction' || part?.synthetic === true)) {
        const candidates = [...promptRequestsByPart.values()]
          .filter((candidate) => candidate.sessionId === event.properties?.sessionID);
        if (candidates.length === 1) [request] = candidates;
      }
      if (request && typeof part?.messageID === 'string') {
        promptRequestsByMessage.set(part.messageID, request);
      }
      return;
    }
    const info = event.type === 'message.updated' ? event.properties?.info : null;
    if (completePrompt && typeof info?.time?.completed === 'number') resolvePrompt(info);
  };
  return {
    push(event, { completePrompt = true } = {}) {
      events.push({ directory: '/repo', payload: event });
      for (const resolve of waiters.splice(0)) resolve();
      observe(event, completePrompt);
    },
    resolvePrompt,
    prompt(input, options) {
      return new Promise((resolve, reject) => {
        const partId = input.parts[0].id;
        const request = { resolve, sessionId: input.sessionID };
        promptRequestsByPart.set(partId, request);
        const abort = () => {
          promptRequestsByPart.delete(partId);
          reject(options.signal.reason ?? new Error('OpenCode prompt request aborted'));
        };
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

function createRuntime(sessionIds, options = {}) {
  const eventStream = createEventStream();
  const promptAsync = mock(() => Promise.resolve({}));
  const prompt = mock((...args) => {
    void promptAsync(...args);
    return eventStream.prompt(...args);
  });
  const create = mock(() => Promise.resolve({ data: { id: sessionIds.shift() } }));
  const permissionReply = mock(() => Promise.resolve({}));
  const runtime = new OpenCodeRuntime({
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: permissionReply },
        global: { event: mock(() => Promise.resolve({ stream: eventStream.stream() })) },
        session: {
          create,
          prompt,
          promptAsync,
          abort: mock(() => Promise.resolve({ data: true })),
        },
      },
      server: { close: mock(() => undefined) },
    })),
    ...options,
  });
  return { create, eventStream, permissionReply, promptAsync, runtime };
}

function operation(runId, events) {
  return { runId, publish: (event) => events.push(event) };
}

function promptPart(promptAsync, callIndex) {
  return promptAsync.mock.calls[callIndex][0].parts[0].id;
}

function pushPrompt(eventStream, {
  eventId,
  messageId,
  partId,
  sessionId,
  text,
}) {
  eventStream.push({
    id: eventId,
    type: 'message.part.updated',
    properties: {
      sessionID: sessionId,
      part: { id: partId, messageID: messageId, type: 'text', text },
    },
  });
}

function pushAssistant(eventStream, {
  eventNumber,
  messageId,
  parentId,
  sessionId,
  text,
}) {
  eventStream.push({
    id: `event-${String(eventNumber).padStart(2, '0')}`,
    type: 'message.updated',
    properties: {
      sessionID: sessionId,
      info: { id: messageId, role: 'assistant', parentID: parentId },
    },
  });
  eventStream.push({
    id: `event-${String(eventNumber + 1).padStart(2, '0')}`,
    type: 'message.part.updated',
    properties: {
      sessionID: sessionId,
      part: { id: `part-${messageId}`, messageID: messageId, type: 'text', text },
    },
  });
}

function pushTerminal(eventStream, {
  eventId,
  messageId,
  parentId,
  sessionId,
  completePrompt = true,
}) {
  eventStream.push({
    id: eventId,
    type: 'message.updated',
    properties: {
      sessionID: sessionId,
      info: {
        id: messageId,
        role: 'assistant',
        parentID: parentId,
        finish: 'stop',
        time: { completed: 1 },
      },
    },
  }, { completePrompt });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

describe('OpenCode operation routing', () => {
  it('[TLV5-L07.07-OPENCODE-UNIT-01] preserves an established operation when a replacement start fails', async () => {
    const { create, eventStream, promptAsync, runtime } = createRuntime(['session-1']);
    const establishedEvents = [];
    const replacementEvents = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', establishedEvents),
    });
    create.mockRejectedValueOnce(new Error('replacement start failed'));

    await expect(runtime.startSession({
      command: 'replacement',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-b', replacementEvents),
    })).rejects.toThrow('replacement start failed');

    pushPrompt(eventStream, {
      eventId: 'event-01',
      messageId: 'user-a',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-1',
      text: 'first',
    });
    pushAssistant(eventStream, {
      eventNumber: 2,
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
      text: 'established reply',
    });
    pushTerminal(eventStream, {
      eventId: 'event-04',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => establishedEvents.some((event) => event.type === 'run-ended'));

    expect(JSON.stringify(establishedEvents)).toContain('established reply');
    expect(replacementEvents).toEqual([]);
    eventStream.close();
    await runtime.shutdown();
  });

  it('[TLV5-L07.05-OPENCODE-UNIT-01] logs and drops output without an operation identity', async () => {
    const diagnostics = [];
    const { eventStream, runtime } = createRuntime(['session-1'], {
      logger: {
        debug(...args) { diagnostics.push(args); },
        info(...args) { diagnostics.push(args); },
        warn(...args) { diagnostics.push(args); },
        error(...args) { diagnostics.push(args); },
      },
    });
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });

    eventStream.push({
      id: 'event-orphan',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-orphan',
          messageID: 'message-orphan',
          type: 'text',
          text: 'orphan output',
        },
      },
    });
    await waitFor(() => diagnostics.some((entry) => (
      entry[0] === 'Ignoring an OpenCode event without an operation identity'
    )));

    expect(events).toEqual([]);
    eventStream.close();
    await runtime.shutdown();
  });

  it('[TLV5-L07.03-OPENCODE-UNIT-01] publishes late named rows and permissions through the operation that produced them', async () => {
    const { eventStream, permissionReply, promptAsync, runtime } = createRuntime(['session-1']);
    const firstEvents = [];
    const secondEvents = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', firstEvents),
    });
    const firstPromptPartId = promptPart(promptAsync, 0);
    pushPrompt(eventStream, {
      eventId: 'event-01',
      messageId: 'user-a',
      partId: firstPromptPartId,
      sessionId: 'session-1',
      text: 'first',
    });
    pushAssistant(eventStream, {
      eventNumber: 2,
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
      text: 'first reply',
    });
    pushTerminal(eventStream, {
      eventId: 'event-04',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
      completePrompt: false,
    });
    await Promise.resolve();
    expect(firstEvents.some((event) => event.type === 'run-ended')).toBe(false);

    pushAssistant(eventStream, {
      eventNumber: 5,
      messageId: 'assistant-a-late',
      parentId: 'user-a',
      sessionId: 'session-1',
      text: 'late first reply',
    });
    eventStream.push({
      id: 'event-07',
      type: 'permission.asked',
      properties: {
        sessionID: 'session-1',
        requestID: 'permission-a',
        permission: 'bash',
        tool: { messageID: 'assistant-a-late' },
      },
    });
    await waitFor(() => firstEvents.some((event) => (
      event.type === 'permission' && event.lifecycle.kind === 'requested'
    )));
    const permission = firstEvents.find((event) => (
      event.type === 'permission' && event.lifecycle.kind === 'requested'
    ));
    await permission.decision.respond({ allow: true });
    expect(permissionReply.mock.calls.at(-1)[0]).toMatchObject({
      requestID: 'permission-a',
      reply: 'once',
    });
    eventStream.resolvePrompt({
      id: 'assistant-a',
      role: 'assistant',
      parentID: 'user-a',
      finish: 'stop',
      time: { completed: 1 },
    });
    await waitFor(() => firstEvents.some((event) => event.type === 'run-ended'));
    const retiredEventCount = firstEvents.length;
    eventStream.push({
      id: 'event-after-source-retirement',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-after-source-retirement',
          messageID: 'assistant-a',
          type: 'text',
          text: 'too late for the retired source',
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstEvents).toHaveLength(retiredEventCount);

    const successor = runtime.runTurn({
      command: 'second',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-b', secondEvents),
    });
    await waitFor(() => promptAsync.mock.calls.length === 2);
    pushPrompt(eventStream, {
      eventId: 'event-08',
      messageId: 'user-b',
      partId: promptPart(promptAsync, 1),
      sessionId: 'session-1',
      text: 'second',
    });
    pushAssistant(eventStream, {
      eventNumber: 9,
      messageId: 'assistant-b',
      parentId: 'user-b',
      sessionId: 'session-1',
      text: 'second reply',
    });
    pushTerminal(eventStream, {
      eventId: 'event-11',
      messageId: 'assistant-b',
      parentId: 'user-b',
      sessionId: 'session-1',
    });

    await expect(successor).resolves.toBeUndefined();
    const firstMessages = firstEvents
      .filter((event) => event.type === 'messages')
      .flatMap((event) => event.rows.map((row) => row.message));
    const secondMessages = secondEvents
      .filter((event) => event.type === 'messages')
      .flatMap((event) => event.rows.map((row) => row.message));
    expect(firstEvents.map((event) => event.type)).toEqual([
      'messages',
      'messages',
      'permission',
      'run-ended',
    ]);
    expect(firstMessages.slice(0, 2).map((message) => message.content)).toEqual([
      'first reply',
      'late first reply',
    ]);
    expect(permission).toMatchObject({
      type: 'permission',
      runId: 'run-a',
      lifecycle: {
        kind: 'requested',
        requestedTool: { type: 'request-permissions-tool-use' },
      },
    });
    expect(secondMessages.map((message) => message.content)).toEqual(['second reply']);
    expect(secondEvents.at(-1)).toMatchObject({
      type: 'run-ended',
      runId: 'run-b',
      outcome: 'finished',
    });

    eventStream.close();
    await runtime.shutdown();
  });

  it('drops old session-scoped terminal events after a successor binds', async () => {
    const diagnostics = [];
    const { eventStream, promptAsync, runtime } = createRuntime(['session-1'], {
      logger: {
        debug(...args) { diagnostics.push(args); },
        info() {},
        warn() {},
        error() {},
      },
    });
    const firstEvents = [];
    const secondEvents = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', firstEvents),
    });
    pushPrompt(eventStream, {
      eventId: 'event-01',
      messageId: 'user-a',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-1',
      text: 'first',
    });
    pushAssistant(eventStream, {
      eventNumber: 2,
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
      text: 'first reply',
    });
    pushTerminal(eventStream, {
      eventId: 'event-04',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => firstEvents.some((event) => event.type === 'run-ended'));

    const successor = runtime.runTurn({
      command: 'second',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-b', secondEvents),
    });
    await waitFor(() => promptAsync.mock.calls.length === 2);
    pushPrompt(eventStream, {
      eventId: 'event-05',
      messageId: 'user-b',
      partId: promptPart(promptAsync, 1),
      sessionId: 'session-1',
      text: 'second',
    });
    const firstEventCount = firstEvents.length;
    eventStream.push({
      id: 'event-old-error',
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'ProviderError', data: { message: 'old failure' } },
      },
    });
    eventStream.push({
      id: 'event-old-idle',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });
    await waitFor(() => diagnostics.filter((entry) => (
      entry[0] === 'Ignoring an OpenCode event without an operation identity'
      && (entry[1]?.eventId === 'event-old-error' || entry[1]?.eventId === 'event-old-idle')
    )).length === 2);

    expect(firstEvents).toHaveLength(firstEventCount);
    expect(secondEvents).toEqual([]);

    pushAssistant(eventStream, {
      eventNumber: 6,
      messageId: 'assistant-b',
      parentId: 'user-b',
      sessionId: 'session-1',
      text: 'second reply',
    });
    pushTerminal(eventStream, {
      eventId: 'event-08',
      messageId: 'assistant-b',
      parentId: 'user-b',
      sessionId: 'session-1',
    });
    await expect(successor).resolves.toBeUndefined();
    expect(secondEvents).toEqual([
      expect.objectContaining({ type: 'messages' }),
      expect.objectContaining({ type: 'run-ended', runId: 'run-b', outcome: 'finished' }),
    ]);

    eventStream.close();
    await runtime.shutdown();
  });

  it('keeps an exact permission capability pending after a failed forward', async () => {
    const { eventStream, permissionReply, promptAsync, runtime } = createRuntime(['session-1']);
    permissionReply
      .mockRejectedValueOnce(new Error('permission reply failed'))
      .mockResolvedValueOnce({});
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });
    pushPrompt(eventStream, {
      eventId: 'event-01',
      messageId: 'user-a',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-1',
      text: 'first',
    });
    pushAssistant(eventStream, {
      eventNumber: 2,
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
      text: 'answer',
    });
    eventStream.push({
      id: 'event-04',
      type: 'permission.asked',
      properties: {
        sessionID: 'session-1',
        requestID: 'permission-a',
        permission: 'bash',
        tool: { messageID: 'assistant-a' },
      },
    });
    await waitFor(() => events.some((event) => event.type === 'permission'));
    const permission = events.find((event) => event.type === 'permission');

    await expect(permission.decision.respond({ allow: true }))
      .rejects.toThrow('permission reply failed');
    await expect(permission.decision.respond({ allow: false })).resolves.toBeUndefined();
    expect(permissionReply).toHaveBeenCalledTimes(2);

    pushTerminal(eventStream, {
      eventId: 'event-05',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    eventStream.close();
    await runtime.shutdown();
  });

  it('[TLV5-PERM.04-OPENCODE-UNIT-01] keeps reused provider permission ids bound to separate decision capabilities', async () => {
    const { eventStream, permissionReply, promptAsync, runtime } = createRuntime(['session-1']);
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });
    pushPrompt(eventStream, {
      eventId: 'event-01',
      messageId: 'user-a',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-1',
      text: 'first',
    });
    pushAssistant(eventStream, {
      eventNumber: 2,
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
      text: 'answer',
    });
    const request = (eventId) => eventStream.push({
      id: eventId,
      type: 'permission.asked',
      properties: {
        sessionID: 'session-1',
        requestID: 'permission-reused',
        permission: 'bash',
        tool: { messageID: 'assistant-a' },
      },
    });

    request('event-04');
    await waitFor(() => events.some((event) => event.type === 'permission'));
    const first = events.find((event) => event.type === 'permission');
    await first.decision.respond({ allow: true });

    request('event-05');
    await waitFor(() => events.filter((event) => event.type === 'permission').length === 2);
    const permissions = events.filter((event) => event.type === 'permission');
    const second = permissions[1];
    expect(second.lifecycle.requestId).not.toBe(first.lifecycle.requestId);
    expect(second.lifecycle.incarnation).not.toBe(first.lifecycle.incarnation);
    await expect(first.decision.respond({ allow: false }))
      .rejects.toThrow('no longer pending');
    await second.decision.respond({ allow: false });
    expect(permissionReply.mock.calls.map(([input]) => ({
      requestID: input.requestID,
      reply: input.reply,
    }))).toEqual([
      { requestID: 'permission-reused', reply: 'once' },
      { requestID: 'permission-reused', reply: 'reject' },
    ]);

    pushTerminal(eventStream, {
      eventId: 'event-06',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    eventStream.close();
    await runtime.shutdown();
  });

  it('[TLV5-L07.04-OPENCODE-UNIT-01] does not cross-route equal provider message identities from different sessions', async () => {
    const { eventStream, promptAsync, runtime } = createRuntime(['session-a', 'session-b']);
    const firstEvents = [];
    const secondEvents = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-a',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', firstEvents),
    });
    await runtime.startSession({
      command: 'second',
      chatId: 'chat-b',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-b', secondEvents),
    });
    pushPrompt(eventStream, {
      eventId: 'event-a-1',
      messageId: 'shared-user',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-a',
      text: 'first',
    });
    pushPrompt(eventStream, {
      eventId: 'event-b-1',
      messageId: 'shared-user',
      partId: promptPart(promptAsync, 1),
      sessionId: 'session-b',
      text: 'second',
    });
    pushAssistant(eventStream, {
      eventNumber: 2,
      messageId: 'shared-assistant',
      parentId: 'shared-user',
      sessionId: 'session-a',
      text: 'from A',
    });
    eventStream.push({
      id: 'event-b-2',
      type: 'message.updated',
      properties: {
        sessionID: 'session-b',
        info: { id: 'shared-assistant', role: 'assistant', parentID: 'shared-user' },
      },
    });
    eventStream.push({
      id: 'event-b-3',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-b',
        part: {
          id: 'part-shared-assistant',
          messageID: 'shared-assistant',
          type: 'text',
          text: 'from B',
        },
      },
    });
    await waitFor(() => firstEvents.length === 1 && secondEvents.length === 1);

    expect(firstEvents[0].rows[0].message.content).toBe('from A');
    expect(secondEvents[0].rows[0].message.content).toBe('from B');

    eventStream.close();
    await runtime.shutdown();
  });
});
