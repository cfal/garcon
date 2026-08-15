import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

function createEventStream() {
  const events = [{
    payload: { id: 'event-connected', type: 'server.connected', properties: {} },
  }];
  const waiters = [];
  let closed = false;
  return {
    push(event) {
      events.push({ directory: '/repo', payload: event });
      for (const resolve of waiters.splice(0)) resolve();
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
  const create = mock(() => Promise.resolve({ data: { id: sessionIds.shift() } }));
  const permissionReply = mock(() => Promise.resolve({}));
  const runtime = new OpenCodeRuntime({
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: permissionReply },
        global: { event: mock(() => Promise.resolve({ stream: eventStream.stream() })) },
        session: {
          create,
          promptAsync,
          abort: mock(() => Promise.resolve({ data: true })),
        },
      },
      server: { close: mock(() => undefined) },
    })),
  });
  return { eventStream, permissionReply, promptAsync, runtime };
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

function pushIdle(eventStream, sessionId, eventId) {
  eventStream.push({
    id: eventId,
    type: 'session.status',
    properties: { sessionID: sessionId, status: { type: 'idle' } },
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

describe('OpenCode operation routing', () => {
  it('publishes late named rows and permissions through the operation that produced them', async () => {
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
    pushIdle(eventStream, 'session-1', 'event-04');
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
    pushPrompt(eventStream, {
      eventId: 'event-06',
      messageId: 'user-a',
      partId: firstPromptPartId,
      sessionId: 'session-1',
      text: 'first',
    });
    pushAssistant(eventStream, {
      eventNumber: 7,
      messageId: 'assistant-a-late',
      parentId: 'user-a',
      sessionId: 'session-1',
      text: 'late first reply',
    });
    eventStream.push({
      id: 'event-09',
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
    pushAssistant(eventStream, {
      eventNumber: 10,
      messageId: 'assistant-b',
      parentId: 'user-b',
      sessionId: 'session-1',
      text: 'second reply',
    });
    pushIdle(eventStream, 'session-1', 'event-12');

    await expect(successor).resolves.toBeUndefined();
    const firstMessages = firstEvents
      .filter((event) => event.type === 'messages')
      .flatMap((event) => event.rows.map((row) => row.message));
    const secondMessages = secondEvents
      .filter((event) => event.type === 'messages')
      .flatMap((event) => event.rows.map((row) => row.message));
    expect(firstEvents.map((event) => event.type)).toEqual([
      'messages',
      'run-ended',
      'messages',
      'permission',
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

    pushIdle(eventStream, 'session-1', 'event-05');
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    eventStream.close();
    await runtime.shutdown();
  });

  it('does not cross-route equal provider message identities from different sessions', async () => {
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
