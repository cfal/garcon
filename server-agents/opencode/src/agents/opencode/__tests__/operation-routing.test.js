import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

const PERMISSION_OCCURRENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createEventStream() {
  const events = [{
    payload: { id: 'event-connected', type: 'server.connected', properties: {} },
  }];
  const waiters = [];
  const promptRequestsByPart = new Map();
  const promptRequestsByMessage = new Map();
  const promptRequestsBySession = new Map();
  let closed = false;
  const resolvePrompt = (info) => {
    const request = promptRequestsByMessage.get(info.parentID);
    if (request) setImmediate(() => request.resolve({ data: { info, parts: [] } }));
  };
  const observe = (event, completePrompt) => {
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part;
      const operationPartId = part?.metadata?.garcon_operation_part_id ?? part?.id;
      const request = promptRequestsByPart.get(operationPartId)
        ?? (part?.metadata?.compaction_continue === true
          ? promptRequestsBySession.get(part.sessionID ?? event.properties?.sessionID)
          : undefined);
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
        promptRequestsBySession.set(input.sessionID, request);
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
  const questionReply = mock(() => Promise.resolve({}));
  const questionReject = mock(() => Promise.resolve({}));
  const runtime = new OpenCodeRuntime({
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: permissionReply },
        question: { reply: questionReply, reject: questionReject },
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
  return {
    create,
    eventStream,
    permissionReply,
    promptAsync,
    questionReject,
    questionReply,
    runtime,
  };
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

function pushCompactionPart(eventStream, {
  eventId,
  kind = 'control',
  messageId = 'user-compaction',
  partId = 'part-compaction',
  sessionId,
}) {
  const part = kind === 'control'
    ? { type: 'compaction', auto: true }
    : {
        type: 'text',
        synthetic: true,
        metadata: { compaction_continue: true },
        text: 'Continue after automatic compaction.',
      };
  if (partId !== null) part.id = partId;
  if (messageId !== null) part.messageID = messageId;
  eventStream.push({
    id: eventId,
    type: 'message.part.updated',
    properties: { sessionID: sessionId, part },
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

function pushTaskChild(eventStream, {
  childSessionId,
  eventId,
  messageId,
  parentSessionId,
}) {
  eventStream.push({
    id: eventId,
    type: 'message.part.updated',
    properties: {
      sessionID: parentSessionId,
      part: {
        id: `part-task-${childSessionId}`,
        messageID: messageId,
        type: 'tool',
        tool: 'task',
        callID: `call-task-${childSessionId}`,
        state: {
          status: 'running',
          input: { description: 'Run a deterministic child task' },
          metadata: { sessionId: childSessionId },
        },
      },
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

function diagnosticLogger() {
  const debug = [];
  const warnings = [];
  return {
    debug,
    warnings,
    logger: {
      debug(...args) { debug.push(args); },
      info() {},
      warn(...args) { warnings.push(args); },
      error() {},
    },
  };
}

function missingOpenCodeRequestResult() {
  return {
    error: {
      name: 'NotFoundError',
      data: { message: 'Question request not found' },
    },
    response: { status: 404 },
  };
}

function compactionWarningCodes(warnings) {
  return warnings
    .filter(([message]) => message === 'Dropping an OpenCode compaction part')
    .map(([, details]) => details.code);
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

  it('[TLV5-PERM.09-OPENCODE-UNIT-01] logs and drops a permission without an operation identity', async () => {
    const warnings = [];
    const { eventStream, runtime } = createRuntime(['session-1'], {
      logger: {
        debug() {},
        info() {},
        warn(...args) { warnings.push(args); },
        error() {},
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
      id: 'unowned-permission-event',
      type: 'permission.asked',
      properties: {
        sessionID: 'session-1',
        requestID: 'sensitive-native-request-id',
        permission: 'bash',
        metadata: { command: 'sensitive-command-must-not-be-logged' },
        tool: { messageID: 'unowned-provider-message' },
      },
    });
    await waitFor(() => warnings.length === 1);

    expect(events).toEqual([]);
    expect(warnings).toEqual([[
      'Ignoring an OpenCode event without an operation identity',
      expect.objectContaining({
        eventId: 'unowned-permission-event',
        eventType: 'permission.asked',
        sessionId: 'session-1',
      }),
    ]]);
    expect(JSON.stringify(warnings)).not.toContain('sensitive-native-request-id');
    expect(JSON.stringify(warnings)).not.toContain('sensitive-command-must-not-be-logged');
    eventStream.close();
    await runtime.shutdown();
  });

  it('logs and drops a question without an operation identity', async () => {
    const warnings = [];
    const { eventStream, runtime } = createRuntime(['session-1'], {
      logger: {
        debug() {},
        info() {},
        warn(...args) { warnings.push(args); },
        error() {},
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
      id: 'unowned-question-event',
      type: 'question.asked',
      properties: {
        id: 'sensitive-native-question-id',
        sessionID: 'session-1',
        questions: [{
          header: 'Private',
          question: 'sensitive-question-must-not-be-logged',
          options: [],
        }],
        tool: {
          callID: 'sensitive-tool-call-id',
          messageID: 'unowned-provider-message',
        },
      },
    });
    await waitFor(() => warnings.length === 1);

    expect(events).toEqual([]);
    expect(warnings).toEqual([[
      'Ignoring an OpenCode event without an operation identity',
      expect.objectContaining({
        eventId: 'unowned-question-event',
        eventType: 'question.asked',
        sessionId: 'session-1',
      }),
    ]]);
    expect(JSON.stringify(warnings)).not.toContain('sensitive-native-question-id');
    expect(JSON.stringify(warnings)).not.toContain('sensitive-tool-call-id');
    expect(JSON.stringify(warnings)).not.toContain('sensitive-question-must-not-be-logged');
    eventStream.close();
    await runtime.shutdown();
  });

  it('routes an OpenCode question and retains its capability after a failed reply', async () => {
    const {
      eventStream,
      promptAsync,
      questionReject,
      questionReply,
      runtime,
    } = createRuntime(['session-1']);
    questionReply
      .mockRejectedValueOnce(new Error('question reply failed'))
      .mockResolvedValueOnce({});
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'bypassPermissions',
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
      text: 'Preparing a question.',
    });
    eventStream.push({
      id: 'event-question-asked',
      type: 'question.asked',
      properties: {
        id: 'provider-question-request',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Mode',
            question: 'Which mode?',
            options: [
              { label: 'Fast', description: 'Complete quickly.' },
              { label: 'Careful', description: 'Check boundaries.' },
            ],
          },
          {
            header: 'Checks',
            question: 'Which checks?',
            multiple: true,
            options: [
              { label: 'Unit', description: 'Run unit tests.' },
              { label: 'Integration', description: 'Run integration tests.' },
            ],
          },
        ],
        tool: { callID: 'call-question', messageID: 'assistant-a' },
      },
    });
    await waitFor(() => events.some((event) => event.type === 'permission'));

    const request = events.find((event) => event.type === 'permission');
    expect(request.lifecycle.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
    expect(request.lifecycle.permissionOccurrenceId).not.toBe('provider-question-request');
    expect(request.lifecycle.requestedTool).toMatchObject({
      type: 'ask-user-question-tool-use',
      toolId: 'call-question',
      questions: [
        {
          id: 'question-1',
          prompt: 'Which mode?',
          allowMultiple: false,
          options: [
            {
              id: 'question-1-option-1',
              label: 'Fast',
              description: 'Complete quickly.',
            },
            {
              id: 'question-1-option-2',
              label: 'Careful',
              description: 'Check boundaries.',
            },
          ],
        },
        {
          id: 'question-2',
          prompt: 'Which checks?',
          allowMultiple: true,
        },
      ],
    });

    const decision = {
      allow: true,
      response: {
        type: 'ask-user-question-response',
        outcome: 'answered',
        answers: [
          { questionId: 'question-1', selectedOptionIds: ['question-1-option-2'] },
          {
            questionId: 'question-2',
            selectedOptionIds: ['question-2-option-1', 'question-2-option-2'],
          },
        ],
      },
    };
    await expect(request.decision.respond(decision)).rejects.toThrow('question reply failed');
    await expect(request.decision.respond(decision)).resolves.toBeUndefined();
    expect(questionReply).toHaveBeenCalledTimes(2);
    expect(questionReply.mock.calls[1][0]).toMatchObject({
      requestID: 'provider-question-request',
      answers: [['Careful'], ['Unit', 'Integration']],
    });
    expect(questionReject).not.toHaveBeenCalled();

    pushTerminal(eventStream, {
      eventId: 'event-terminal',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    eventStream.close();
    await runtime.shutdown();
  });

  it('rejects an OpenCode question when the generic question response is skipped', async () => {
    const {
      eventStream,
      promptAsync,
      questionReject,
      questionReply,
      runtime,
    } = createRuntime(['session-1']);
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
      text: 'Preparing a question.',
    });
    eventStream.push({
      id: 'event-question-asked',
      type: 'question.asked',
      properties: {
        id: 'provider-question-request',
        sessionID: 'session-1',
        questions: [{
          header: 'Continue',
          question: 'Continue?',
          options: [{ label: 'Yes', description: 'Continue.' }],
        }],
        tool: { callID: 'call-question', messageID: 'assistant-a' },
      },
    });
    await waitFor(() => events.some((event) => event.type === 'permission'));

    const request = events.find((event) => event.type === 'permission');
    await request.decision.respond({
      allow: false,
      response: {
        type: 'ask-user-question-response',
        outcome: 'skipped',
        reason: 'User skipped question',
      },
    });
    expect(questionReject).toHaveBeenCalledTimes(1);
    expect(questionReject.mock.calls[0][0]).toMatchObject({
      requestID: 'provider-question-request',
    });
    expect(questionReply).not.toHaveBeenCalled();

    pushTerminal(eventStream, {
      eventId: 'event-terminal',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    eventStream.close();
    await runtime.shutdown();
  });

  it('rejects an owned question that has no renderable prompts', async () => {
    const {
      eventStream,
      promptAsync,
      questionReject,
      runtime,
    } = createRuntime(['session-1']);
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'bypassPermissions',
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
      text: 'Preparing a question.',
    });
    eventStream.push({
      id: 'event-question-empty',
      type: 'question.asked',
      properties: {
        id: 'provider-question-empty',
        sessionID: 'session-1',
        questions: [],
        tool: { callID: 'call-question-empty', messageID: 'assistant-a' },
      },
    });

    await waitFor(() => questionReject.mock.calls.length === 1);
    expect(questionReject.mock.calls[0][0]).toMatchObject({
      requestID: 'provider-question-empty',
    });
    expect(events.filter((event) => event.type === 'permission')).toEqual([]);

    pushTerminal(eventStream, {
      eventId: 'event-terminal',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    eventStream.close();
    await runtime.shutdown();
  });

  it('treats a missing unrenderable-question request as already settled', async () => {
    const diagnostics = diagnosticLogger();
    const {
      eventStream,
      promptAsync,
      questionReject,
      runtime,
    } = createRuntime(['session-1'], { logger: diagnostics.logger });
    questionReject.mockResolvedValueOnce(missingOpenCodeRequestResult());
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'bypassPermissions',
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
      text: 'Preparing a question.',
    });
    eventStream.push({
      id: 'event-question-missing',
      type: 'question.asked',
      properties: {
        id: 'provider-question-missing',
        sessionID: 'session-1',
        questions: [],
        tool: { callID: 'call-question-missing', messageID: 'assistant-a' },
      },
    });

    await waitFor(() => (
      diagnostics.debug.some(([message]) => (
        message === 'Ignoring an OpenCode rejection for a missing question request'
      ))
      || events.some((event) => event.type === 'run-ended')
    ));
    expect(events.some((event) => event.type === 'run-ended')).toBe(false);

    pushTerminal(eventStream, {
      eventId: 'event-terminal',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    expect(events.at(-1)).toMatchObject({ type: 'run-ended', outcome: 'finished' });
    eventStream.close();
    await runtime.shutdown();
  });

  it('treats a missing manual-bypass permission request as already settled', async () => {
    const diagnostics = diagnosticLogger();
    const {
      eventStream,
      permissionReply,
      promptAsync,
      runtime,
    } = createRuntime(['session-1'], { logger: diagnostics.logger });
    permissionReply.mockResolvedValueOnce(missingOpenCodeRequestResult());
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'manualBypass',
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
      text: 'Preparing a permission request.',
    });
    eventStream.push({
      id: 'event-permission-missing',
      type: 'permission.asked',
      properties: {
        sessionID: 'session-1',
        requestID: 'provider-permission-missing',
        permission: 'bash',
        tool: { callID: 'call-permission-missing', messageID: 'assistant-a' },
      },
    });

    await waitFor(() => (
      diagnostics.debug.some(([message]) => (
        message === 'Ignoring an OpenCode reply for a missing permission request'
      ))
      || events.some((event) => event.type === 'run-ended')
    ));
    expect(events.some((event) => event.type === 'run-ended')).toBe(false);

    pushTerminal(eventStream, {
      eventId: 'event-terminal',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    expect(events.at(-1)).toMatchObject({ type: 'run-ended', outcome: 'finished' });
    eventStream.close();
    await runtime.shutdown();
  });

  it('routes a task child permission through its exact parent operation and hides child output', async () => {
    const diagnostics = diagnosticLogger();
    const {
      eventStream,
      permissionReply,
      promptAsync,
      runtime,
    } = createRuntime(['session-1'], { logger: diagnostics.logger });
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
      text: 'Starting a child task.',
    });
    pushTaskChild(eventStream, {
      childSessionId: 'session-child',
      eventId: 'event-04',
      messageId: 'assistant-a',
      parentSessionId: 'session-1',
    });
    eventStream.push({
      id: 'event-child-user',
      type: 'message.updated',
      properties: {
        sessionID: 'session-child',
        info: { id: 'child-user', role: 'user' },
      },
    });
    pushAssistant(eventStream, {
      eventNumber: 6,
      messageId: 'child-assistant',
      parentId: 'child-user',
      sessionId: 'session-child',
      text: 'CHILD_OUTPUT_MUST_STAY_HIDDEN',
    });
    eventStream.push({
      id: 'event-child-permission',
      type: 'permission.asked',
      properties: {
        id: 'provider-child-permission',
        sessionID: 'session-child',
        permission: 'doom_loop',
        patterns: ['bash'],
        metadata: { tool: 'bash', input: { command: 'true' } },
        tool: { callID: 'call-child-bash', messageID: 'child-assistant' },
      },
    });

    await waitFor(() => events.some((event) => (
      event.type === 'permission' && event.lifecycle.kind === 'requested'
    )));
    const requested = events.find((event) => (
      event.type === 'permission' && event.lifecycle.kind === 'requested'
    ));
    expect(requested.runId).toBe('run-a');
    await requested.decision.respond({ allow: true, alwaysAllow: false });
    expect(permissionReply.mock.calls[0][0]).toMatchObject({
      requestID: 'provider-child-permission',
      reply: 'once',
    });
    expect(JSON.stringify(events)).not.toContain('CHILD_OUTPUT_MUST_STAY_HIDDEN');
    expect(diagnostics.warnings).toEqual([]);

    pushTerminal(eventStream, {
      eventId: 'event-terminal',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
    eventStream.close();
    await runtime.shutdown();
  });

  it('routes a task child question through its exact parent operation', async () => {
    const {
      eventStream,
      promptAsync,
      questionReply,
      runtime,
    } = createRuntime(['session-1']);
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'bypassPermissions',
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
      text: 'Starting a child task.',
    });
    pushTaskChild(eventStream, {
      childSessionId: 'session-child',
      eventId: 'event-04',
      messageId: 'assistant-a',
      parentSessionId: 'session-1',
    });
    eventStream.push({
      id: 'event-child-question',
      type: 'question.asked',
      properties: {
        id: 'provider-child-question',
        sessionID: 'session-child',
        questions: [{
          header: 'Choice',
          question: 'Choose one',
          options: [{ label: 'Alpha', description: 'First choice' }],
        }],
        tool: { callID: 'call-child-question', messageID: 'child-assistant' },
      },
    });

    await waitFor(() => events.some((event) => (
      event.type === 'permission' && event.lifecycle.kind === 'requested'
    )));
    const requested = events.find((event) => (
      event.type === 'permission' && event.lifecycle.kind === 'requested'
    ));
    expect(requested.lifecycle.requestedTool.type).toBe('ask-user-question-tool-use');
    await requested.decision.respond({
      allow: true,
      response: {
        type: 'ask-user-question-response',
        outcome: 'answered',
        answers: [{ questionId: 'question-1', selectedOptionIds: ['question-1-option-1'] }],
      },
    });
    expect(questionReply.mock.calls[0][0]).toMatchObject({
      requestID: 'provider-child-question',
      answers: [['Alpha']],
    });

    pushTerminal(eventStream, {
      eventId: 'event-terminal',
      messageId: 'assistant-a',
      parentId: 'user-a',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));
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
      .filter((event) => event.type === 'rows')
      .flatMap((event) => event.rows.map((row) => row.message));
    const secondMessages = secondEvents
      .filter((event) => event.type === 'rows')
      .flatMap((event) => event.rows.map((row) => row.message));
    expect(firstEvents.map((event) => event.type)).toEqual([
      'rows',
      'rows',
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
        debug(...args) { diagnostics.push(['debug', ...args]); },
        info() {},
        warn(...args) { diagnostics.push(['warn', ...args]); },
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
    // A stale idle status is consumed at the session scope; only retry
    // statuses surface anything, so it publishes nothing for either operation.
    eventStream.push({
      id: 'event-old-idle',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });
    await waitFor(() => diagnostics.some((entry) => (
      entry[0] === 'warn'
      && entry[1] === 'Ignoring an OpenCode event without an operation identity'
      && entry[2]?.eventId === 'event-old-error'
    )));

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
      expect.objectContaining({ type: 'rows' }),
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

  it('[TLV5-PERM.01-OPENCODE-UNIT-01] [TLV5-PERM.04-OPENCODE-UNIT-01] keeps reused provider permission ids bound to separate decision capabilities', async () => {
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

    request('event-05');
    await waitFor(() => events.filter((event) => event.type === 'permission').length === 2);
    const permissions = events.filter((event) => event.type === 'permission');
    const second = permissions[1];
    expect(first.lifecycle.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
    expect(second.lifecycle.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
    expect(first.lifecycle.permissionOccurrenceId).not.toBe('permission-reused');
    expect(second.lifecycle.permissionOccurrenceId).not.toBe(
      first.lifecycle.permissionOccurrenceId,
    );
    await first.decision.respond({ allow: true });
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

  it('routes an automatic compaction summary chain without rows, terminals, or warnings', async () => {
    const diagnostics = diagnosticLogger();
    const { eventStream, promptAsync, runtime } = createRuntime(['session-1'], {
      logger: diagnostics.logger,
    });
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });
    pushPrompt(eventStream, {
      eventId: 'event-prompt',
      messageId: 'user-prompt',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-1',
      text: 'first',
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-control',
      sessionId: 'session-1',
    });
    eventStream.push({
      id: 'event-summary-message',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: {
          id: 'assistant-summary',
          role: 'assistant',
          parentID: 'user-compaction',
          summary: true,
          finish: 'stop',
          time: { completed: 1 },
        },
      },
    }, { completePrompt: false });
    eventStream.push({
      id: 'event-summary-part',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-summary',
          messageID: 'assistant-summary',
          type: 'text',
          text: 'provider-created summary',
        },
      },
    });
    eventStream.push({
      id: 'event-summary-delta',
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'assistant-summary',
        partID: 'part-summary',
        delta: 'provider-created summary delta',
      },
    });
    eventStream.push({
      id: 'event-barrier',
      type: 'session.compacted',
      properties: { sessionID: 'session-1' },
    });
    await waitFor(() => diagnostics.debug.some((entry) => entry[1]?.eventId === 'event-barrier'));

    expect(events).toEqual([]);
    expect(diagnostics.warnings).toEqual([]);
    expect(diagnostics.debug.filter(([message]) => (
      message === 'Adopted an OpenCode compaction part'
    ))).toHaveLength(1);
    eventStream.close();
    await runtime.shutdown();
  });

  it('routes a post-compaction answer and hides provider-created user bookkeeping', async () => {
    const diagnostics = diagnosticLogger();
    const { eventStream, promptAsync, runtime } = createRuntime(['session-1'], {
      logger: diagnostics.logger,
    });
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });
    pushPrompt(eventStream, {
      eventId: 'event-prompt',
      messageId: 'user-prompt',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-1',
      text: 'first',
    });
    eventStream.push({
      id: 'event-continuation-user',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-continuation', role: 'user' },
      },
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-continuation-part',
      kind: 'continuation',
      messageId: 'user-continuation',
      partId: 'part-continuation',
      sessionId: 'session-1',
    });
    pushAssistant(eventStream, {
      eventNumber: 10,
      messageId: 'assistant-answer',
      parentId: 'user-continuation',
      sessionId: 'session-1',
      text: 'user-facing answer',
    });
    pushTerminal(eventStream, {
      eventId: 'event-12',
      messageId: 'assistant-answer',
      parentId: 'user-continuation',
      sessionId: 'session-1',
    });
    await waitFor(() => events.some((event) => event.type === 'run-ended'));

    const messages = events
      .filter((event) => event.type === 'rows')
      .flatMap((event) => event.rows.map((row) => row.message));
    expect(messages.map((message) => message.content)).toEqual(['user-facing answer']);
    expect(events.at(-1)).toMatchObject({
      type: 'run-ended',
      runId: 'run-a',
      outcome: 'finished',
    });
    expect(JSON.stringify(events)).not.toContain('Continue after automatic compaction.');
    expect(compactionWarningCodes(diagnostics.warnings)).toEqual([]);
    expect(diagnostics.warnings).toEqual([[
      'Ignoring an OpenCode event without an operation identity',
      expect.objectContaining({ eventId: 'event-continuation-user' }),
    ]]);
    eventStream.close();
    await runtime.shutdown();
  });

  it('drops compaction parts without a session or an observed prompt exactly once', async () => {
    const diagnostics = diagnosticLogger();
    const { eventStream, runtime } = createRuntime(['session-1'], {
      logger: diagnostics.logger,
    });
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-no-session',
      sessionId: 'session-missing',
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-before-prompt-control',
      sessionId: 'session-1',
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-before-prompt-continuation',
      kind: 'continuation',
      sessionId: 'session-1',
    });
    await waitFor(() => diagnostics.warnings.length === 3);

    expect(compactionWarningCodes(diagnostics.warnings)).toEqual([
      'COMPACTION_PART_NO_SESSION',
      'COMPACTION_PART_BEFORE_PROMPT',
      'COMPACTION_PART_BEFORE_PROMPT',
    ]);
    expect(events).toEqual([]);
    expect(JSON.stringify(diagnostics.warnings)).not.toContain(
      'Continue after automatic compaction.',
    );
    eventStream.close();
    await runtime.shutdown();
  });

  it('drops compaction parts for completed and aborted sessions exactly once', async () => {
    const diagnostics = diagnosticLogger();
    const { eventStream, promptAsync, runtime } = createRuntime(['session-complete', 'session-abort'], {
      logger: diagnostics.logger,
    });
    const completedEvents = [];
    await runtime.startSession({
      command: 'complete',
      chatId: 'chat-complete',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-complete', completedEvents),
    });
    pushPrompt(eventStream, {
      eventId: 'event-complete-prompt',
      messageId: 'user-complete',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-complete',
      text: 'complete',
    });
    pushTerminal(eventStream, {
      eventId: 'event-complete-terminal',
      messageId: 'assistant-complete',
      parentId: 'user-complete',
      sessionId: 'session-complete',
    });
    await waitFor(() => completedEvents.some((event) => event.type === 'run-ended'));
    pushCompactionPart(eventStream, {
      eventId: 'event-after-complete',
      sessionId: 'session-complete',
    });

    const abortedEvents = [];
    await runtime.startSession({
      command: 'abort',
      chatId: 'chat-abort',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-abort', abortedEvents),
    });
    pushPrompt(eventStream, {
      eventId: 'event-abort-prompt',
      messageId: 'user-abort',
      partId: promptPart(promptAsync, 1),
      sessionId: 'session-abort',
      text: 'abort',
    });
    await waitFor(() => runtime.isRunning('session-abort'));
    await expect(runtime.abort('session-abort')).resolves.toBe(true);
    pushCompactionPart(eventStream, {
      eventId: 'event-after-abort',
      kind: 'continuation',
      sessionId: 'session-abort',
    });
    await waitFor(() => compactionWarningCodes(diagnostics.warnings).length === 2);

    expect(compactionWarningCodes(diagnostics.warnings)).toEqual([
      'COMPACTION_PART_SESSION_NOT_RUNNING',
      'COMPACTION_PART_SESSION_NOT_RUNNING',
    ]);
    eventStream.close();
    await runtime.shutdown();
  });

  it('does not adopt into another session after the owning route retires', async () => {
    const diagnostics = diagnosticLogger();
    const { eventStream, promptAsync, runtime } = createRuntime(['session-old', 'session-new'], {
      logger: diagnostics.logger,
    });
    const oldEvents = [];
    const newEvents = [];
    await runtime.startSession({
      command: 'old',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-old', oldEvents),
    });
    pushPrompt(eventStream, {
      eventId: 'event-old-prompt',
      messageId: 'user-old',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-old',
      text: 'old',
    });
    await runtime.startSession({
      command: 'new',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-new', newEvents),
    });
    pushPrompt(eventStream, {
      eventId: 'event-new-prompt',
      messageId: 'user-new',
      partId: promptPart(promptAsync, 1),
      sessionId: 'session-new',
      text: 'new',
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-retired-route',
      sessionId: 'session-old',
    });
    await waitFor(() => diagnostics.warnings.length === 1);

    expect(compactionWarningCodes(diagnostics.warnings)).toEqual([
      'COMPACTION_PART_ROUTE_RETIRED',
    ]);
    expect(oldEvents).toEqual([]);
    expect(newEvents).toEqual([]);
    eventStream.close();
    await runtime.shutdown();
  });

  it('drops malformed compaction identities once without transcript content', async () => {
    const diagnostics = diagnosticLogger();
    const { eventStream, promptAsync, runtime } = createRuntime(['session-1'], {
      logger: diagnostics.logger,
    });
    const events = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', events),
    });
    pushPrompt(eventStream, {
      eventId: 'event-prompt',
      messageId: 'user-prompt',
      partId: promptPart(promptAsync, 0),
      sessionId: 'session-1',
      text: 'first',
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-missing-part-id',
      partId: null,
      sessionId: 'session-1',
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-missing-message-id',
      messageId: null,
      sessionId: 'session-1',
    });
    await waitFor(() => diagnostics.warnings.length === 2);

    expect(compactionWarningCodes(diagnostics.warnings)).toEqual([
      'COMPACTION_PART_INVALID_IDENTIFIERS',
      'COMPACTION_PART_INVALID_IDENTIFIERS',
    ]);
    expect(events).toEqual([]);
    expect(JSON.stringify(diagnostics.warnings)).not.toContain('first');
    eventStream.close();
    await runtime.shutdown();
  });

  it('logs one fixed warning when compaction identities collide', async () => {
    const diagnostics = diagnosticLogger();
    const { eventStream, promptAsync, runtime } = createRuntime(['session-1', 'session-1'], {
      logger: diagnostics.logger,
    });
    const firstEvents = [];
    const secondEvents = [];
    await runtime.startSession({
      command: 'first',
      chatId: 'chat-a',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-a', firstEvents),
    });
    const firstPromptPartId = promptPart(promptAsync, 0);
    pushPrompt(eventStream, {
      eventId: 'event-first-prompt',
      messageId: 'user-first',
      partId: firstPromptPartId,
      sessionId: 'session-1',
      text: 'first',
    });
    await runtime.startSession({
      command: 'second',
      chatId: 'chat-b',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-b', secondEvents),
    });
    pushPrompt(eventStream, {
      eventId: 'event-second-prompt',
      messageId: 'user-second',
      partId: promptPart(promptAsync, 1),
      sessionId: 'session-1',
      text: 'second',
    });
    pushCompactionPart(eventStream, {
      eventId: 'event-collision',
      messageId: 'user-first',
      partId: firstPromptPartId,
      sessionId: 'session-1',
    });
    await waitFor(() => diagnostics.warnings.length === 1);

    expect(compactionWarningCodes(diagnostics.warnings)).toEqual([
      'COMPACTION_PART_IDENTITY_COLLISION',
    ]);
    expect(diagnostics.warnings).toHaveLength(1);
    expect(diagnostics.warnings[0][0]).toBe('Dropping an OpenCode compaction part');
    expect(JSON.stringify(diagnostics.warnings)).not.toContain(
      'Ignoring an OpenCode operation identity collision',
    );
    expect(firstEvents).toEqual([]);
    expect(secondEvents).toEqual([]);
    eventStream.close();
    await runtime.shutdown();
  });
});
