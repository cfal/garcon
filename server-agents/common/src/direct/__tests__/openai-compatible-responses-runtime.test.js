import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  OpenAiCompatibleResponsesRuntime,
  buildOpenAiResponsesUserContent,
  extractOpenAiResponsesTextContent,
  runOpenAiResponsesSingleQuery,
} from '../openai-compatible-responses-runtime.ts';
import {
  consumeResponsesStreamEvent,
  extractResponsesOutputText,
} from '../openai-compatible-responses-protocol.ts';
import {
  createTestDirectSessionStore,
  removeTestDirectSessionStores,
} from './session-store-fixture.ts';

const originalFetch = globalThis.fetch;
const ENDPOINT_ID = 'endpoint-responses';
const ENDPOINT_FINGERPRINT = 'a'.repeat(64);

function streamResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  const events = options.complete === false
    ? chunks
    : [...chunks, {
        type: 'response.completed',
        response: {
          status: 'completed',
          ...(options.responseId ? { id: options.responseId } : {}),
        },
      }];
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function runtimeConfig(overrides = {}) {
  return {
    runtimeLabel: 'Direct (Responses)',
    defaultModel: 'fallback-model',
    endpointId: ENDPOINT_ID,
    endpointFingerprint: ENDPOINT_FINGERPRINT,
    sessions: createTestDirectSessionStore(),
    getApiKey: () => 'sk-test',
    getBaseUrl: () => 'https://api.example.test/v1',
    ...overrides,
  };
}

function captureOperation(runId) {
  const events = [];
  let resolveTerminal;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  return {
    events,
    terminal,
    operation: {
      runId,
      publish(event) {
        events.push(event);
        if (event.type === 'run-ended') resolveTerminal(event);
      },
    },
  };
}

function capturedMessages(capture) {
  return capture.events
    .filter((event) => event.type === 'rows')
    .flatMap((event) => event.rows.map((row) => row.message));
}

function checkpoint(overrides = {}) {
  return {
    kind: 'openai-response',
    responseId: 'resp-seeded',
    endpointId: ENDPOINT_ID,
    endpointFingerprint: ENDPOINT_FINGERPRINT,
    model: 'selected-model',
    ...overrides,
  };
}

async function seedCompletedSession(sessions, overrides = {}) {
  const sessionId = overrides.sessionId ?? '10000000-0000-4000-8000-000000000001';
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
    checkpoint: overrides.checkpoint === undefined ? checkpoint() : overrides.checkpoint,
  });
  return sessionId;
}

function missingCheckpointResponse() {
  return Response.json({
    error: {
      code: 'previous_response_not_found',
      message: 'The previous response cannot be resolved.',
      param: 'previous_response_id',
      type: 'invalid_request_error',
    },
  }, { status: 404 });
}

describe('OpenAiCompatibleResponsesRuntime', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await removeTestDirectSessionStores();
  });

  it('builds text and image input content for the Responses API', () => {
    const content = buildOpenAiResponsesUserContent('hello', [
      { name: 'screen.png', data: 'data:image/png;base64,abc' },
    ]);

    expect(content).toEqual([
      { type: 'input_text', text: 'hello' },
      { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'auto' },
    ]);
    expect(extractOpenAiResponsesTextContent(content)).toBe('hello');
  });

  it('extracts text from common Responses payload shapes', () => {
    expect(extractResponsesOutputText({ output_text: ' hello ' })).toBe('hello');
    expect(extractResponsesOutputText({
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'hel' },
            { type: 'output_text', text: 'lo' },
          ],
        },
      ],
    })).toBe('hello');
  });

  it('tracks streaming deltas, errors, and terminal state', () => {
    const state = {
      text: 'hel',
      errorMessage: null,
      errorCode: null,
      outputAccepted: false,
      responseId: null,
      terminal: null,
    };
    consumeResponsesStreamEvent(state, {
      type: 'response.output_text.delta',
      delta: 'lo',
    });
    expect(state).toEqual({
      text: 'hello',
      errorMessage: null,
      errorCode: null,
      outputAccepted: true,
      responseId: null,
      terminal: null,
    });

    consumeResponsesStreamEvent(state, {
      type: 'response.failed',
      response: { status_details: { error: { message: 'bad request' } } },
    });
    expect(state).toEqual({
      text: 'hello',
      errorMessage: 'bad request',
      errorCode: null,
      outputAccepted: true,
      responseId: null,
      terminal: 'failed',
    });
  });

  it('posts streaming single queries to /responses and extracts output text', async () => {
    let requestUrl = '';
    let requestBody;
    globalThis.fetch = mock(async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(init.body);
      return streamResponse([
        { type: 'response.reasoning_summary_text.delta', delta: 'hidden' },
        { type: 'response.output_text.delta', delta: '<thi' },
        { type: 'response.output_text.delta', delta: 'nk>private</think>' },
        { type: 'response.output_text.delta', delta: '\n single' },
        { type: 'response.output_text.delta', delta: ' response ' },
      ]);
    });

    const result = await runOpenAiResponsesSingleQuery(runtimeConfig(), 'hi', {
      model: 'selected-model',
      thinkingMode: 'ultra',
      timeoutMs: 110_000,
    });

    expect(result).toBe('single response');
    expect(requestUrl).toBe('https://api.example.test/v1/responses');
    expect(requestBody).toEqual({
      model: 'selected-model',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
      store: false,
      reasoning: { effort: 'ultra' },
    });
  });

  it('omits one-shot reasoning for provider Default', async () => {
    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({ output_text: 'single response' });
    });

    await runOpenAiResponsesSingleQuery(runtimeConfig('/tmp/unused'), 'hi', {
      thinkingMode: 'none',
    });

    expect(requestBody).not.toHaveProperty('reasoning');
    expect(requestBody.stream).toBe(true);
  });

  it('accepts buffered JSON when a Responses provider ignores streaming', async () => {
    globalThis.fetch = mock(async () => Response.json({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: '<think>private</think>\n buffered response ',
        }],
      }],
    }));

    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).resolves.toBe('buffered response');
  });

  it('rejects failed and incomplete buffered Responses payloads', async () => {
    globalThis.fetch = mock(async () => Response.json({
      status: 'failed',
      output_text: 'partial',
      error: { message: 'generation failed' },
    }));
    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow('Direct (Responses) response error: generation failed');

    globalThis.fetch = mock(async () => Response.json({
      status: 'incomplete',
      output_text: 'partial',
      incomplete_details: { reason: 'max_output_tokens' },
    }));
    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow('Direct (Responses) response error: max_output_tokens');

    globalThis.fetch = mock(async () => Response.json({
      error: { message: 'buffered provider error' },
    }));
    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow('Direct (Responses) response error: buffered provider error');
  });

  it('rejects a stream error after partial one-shot output', async () => {
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'error', error: { message: 'generation failed' } },
    ]));

    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow('Direct (Responses) stream error: generation failed');
  });

  it('rejects failed and incomplete one-shot streams after partial output', async () => {
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'response.output_text.delta', delta: 'partial' },
      {
        type: 'response.failed',
        response: { error: { message: 'provider failed' } },
      },
    ], { complete: false }));
    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow('Direct (Responses) stream error: provider failed');

    globalThis.fetch = mock(async () => streamResponse([
      { type: 'response.output_text.delta', delta: 'partial' },
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' } },
      },
    ], { complete: false }));
    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow('Direct (Responses) stream error: max_output_tokens');
  });

  it('rejects failed and incomplete one-shot streams before visible output', async () => {
    globalThis.fetch = mock(async () => streamResponse([{
      type: 'response.failed',
      response: { error: { message: 'provider failed before output' } },
    }], { complete: false }));
    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow('Direct (Responses) stream error: provider failed before output');

    globalThis.fetch = mock(async () => streamResponse([{
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'content_filter' } },
    }], { complete: false }));
    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow('Direct (Responses) stream error: content_filter');
  });

  it('requires response.completed for one-shot streams', async () => {
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'response.output_text.delta', delta: 'partial' },
    ], { complete: false }));

    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).rejects.toThrow(
      'Direct (Responses) stream ended before response.completed.',
    );
  });

  it('skips malformed and reasoning events before valid one-shot output', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {malformed}\n\n'));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'response.reasoning_text.delta',
          delta: 'hidden',
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'visible',
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed' },
        })}\n\n`));
        controller.close();
      },
    }), {
      headers: { 'content-type': 'text/event-stream' },
    }));

    await expect(runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
    )).resolves.toBe('visible');
  });

  it('preserves caller abort while reading a one-shot stream', async () => {
    const externalController = new AbortController();
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'partial',
        })}\n\n`));
        init.signal.addEventListener('abort', () => {
          controller.error(init.signal.reason);
        }, { once: true });
      },
    }), {
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = runOpenAiResponsesSingleQuery(
      runtimeConfig('/tmp/unused'),
      'hi',
      { signal: externalController.signal },
    );
    await Promise.resolve();
    externalController.abort(new DOMException('Stopped', 'AbortError'));

    await expect(result).rejects.toThrow('Stopped');
  });

  it('stores first-turn SSE response IDs before emitting assistant text', async () => {
    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return streamResponse([
        { type: 'response.output_text.delta', delta: '<think>private</think>\n' },
        { type: 'response.output_text.delta', delta: 'hello' },
        { type: 'response.output_text.delta', delta: ' world ' },
      ], { responseId: 'resp-first' });
    });

    const config = runtimeConfig();
    const runtime = new OpenAiCompatibleResponsesRuntime(config);
    const capture = captureOperation('run-stream');

    const started = await runtime.startSession({
      chatId: 'chat-1',
      command: 'hi',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      operation: capture.operation,
    });
    await capture.terminal;
    const emitted = capturedMessages(capture);

    expect(requestBody).toEqual({
      model: 'selected-model',
      input: [{ role: 'user', content: 'hi' }],
      previous_response_id: null,
      stream: true,
      store: true,
    });
    expect(emitted[0].content).toBe('hello world');
    expect((await config.sessions.load(started.agentSessionId)).records.at(-1)).toMatchObject({
      type: 'assistant',
      content: 'hello world',
      checkpoint: {
        kind: 'openai-response',
        responseId: 'resp-first',
        endpointId: ENDPOINT_ID,
        endpointFingerprint: ENDPOINT_FINGERPRINT,
        model: 'selected-model',
      },
    });
  });

  it('continues from the durable checkpoint with only the current input', async () => {
    const requestBodies = [];
    globalThis.fetch = mock(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      const responseNumber = requestBodies.length;
      return streamResponse([
        { type: 'response.output_text.delta', delta: `response ${responseNumber}` },
      ], { responseId: `resp-${responseNumber}` });
    });
    const config = runtimeConfig();
    const runtime = new OpenAiCompatibleResponsesRuntime(config);
    const first = captureOperation('run-first');
    const started = await runtime.startSession({
      chatId: 'chat-1',
      command: 'first message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: first.operation,
    });
    await first.terminal;

    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: started.agentSessionId,
      nativeSession: started.nativeSession,
      command: 'second message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: captureOperation('run-second').operation,
    });

    expect(requestBodies).toEqual([
      {
        model: 'selected-model',
        input: [{ role: 'user', content: 'first message' }],
        previous_response_id: null,
        stream: true,
        store: true,
      },
      {
        model: 'selected-model',
        input: [{ role: 'user', content: 'second message' }],
        previous_response_id: 'resp-1',
        stream: true,
        store: true,
      },
    ]);
    expect((await config.sessions.load(started.agentSessionId)).records.at(-1)?.checkpoint)
      .toEqual(checkpoint({ responseId: 'resp-2' }));
  });

  it('continues from a persisted checkpoint after runtime restart', async () => {
    const sessions = createTestDirectSessionStore();
    const sessionId = await seedCompletedSession(sessions);
    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return streamResponse([
        { type: 'response.output_text.delta', delta: 'resumed response' },
      ], { responseId: 'resp-resumed' });
    });
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig({ sessions }));

    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: sessionId,
      nativeSession: sessions.nativeReference(sessionId),
      command: 'resumed message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: captureOperation('run-resumed').operation,
    });

    expect(requestBody).toEqual({
      model: 'selected-model',
      input: [{ role: 'user', content: 'resumed message' }],
      previous_response_id: 'resp-seeded',
      stream: true,
      store: true,
    });
  });

  it('starts a full-context chain when checkpoint endpoint, fingerprint, or model changes', async () => {
    const cases = [
      {
        label: 'endpoint',
        config: { endpointId: 'endpoint-other' },
        model: 'selected-model',
      },
      {
        label: 'fingerprint',
        config: { endpointFingerprint: 'b'.repeat(64) },
        model: 'selected-model',
      },
      {
        label: 'model',
        config: {},
        model: 'changed-model',
      },
    ];

    for (const scenario of cases) {
      const sessions = createTestDirectSessionStore();
      const sessionId = await seedCompletedSession(sessions);
      let requestBody;
      globalThis.fetch = mock(async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return streamResponse([
          { type: 'response.output_text.delta', delta: `${scenario.label} response` },
        ], { responseId: `resp-${scenario.label}` });
      });
      const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig({
        sessions,
        ...scenario.config,
      }));

      await runtime.runTurn({
        chatId: 'chat-1',
        agentSessionId: sessionId,
        nativeSession: sessions.nativeReference(sessionId),
        command: `${scenario.label} message`,
        projectPath: '/tmp/project',
        model: scenario.model,
        permissionMode: 'default',
        thinkingMode: 'none',
        operation: captureOperation(`run-${scenario.label}`).operation,
      });

      expect(requestBody.previous_response_id, scenario.label).toBeNull();
      expect(requestBody.input, scenario.label).toEqual([
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first response' },
        { role: 'user', content: `${scenario.label} message` },
      ]);
      runtime.shutdown();
    }
  });

  it('retries an unresolved checkpoint once with full local history', async () => {
    const sessions = createTestDirectSessionStore();
    const sessionId = await seedCompletedSession(sessions);
    const requestBodies = [];
    globalThis.fetch = mock(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      if (requestBodies.length === 1) return missingCheckpointResponse();
      return streamResponse([
        { type: 'response.output_text.delta', delta: 'recovered response' },
      ], { responseId: 'resp-recovered' });
    });
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig({ sessions }));

    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: sessionId,
      nativeSession: sessions.nativeReference(sessionId),
      command: 'recover message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: captureOperation('run-recover').operation,
    });

    expect(requestBodies[0]).toMatchObject({
      input: [{ role: 'user', content: 'recover message' }],
      previous_response_id: 'resp-seeded',
      store: true,
    });
    expect(requestBodies[1]).toMatchObject({
      input: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first response' },
        { role: 'user', content: 'recover message' },
      ],
      previous_response_id: null,
      store: true,
    });
    expect((await sessions.load(sessionId)).records.at(-1)?.checkpoint)
      .toEqual(checkpoint({ responseId: 'resp-recovered' }));
  });

  it('does not loop when full-context checkpoint recovery also fails', async () => {
    const sessions = createTestDirectSessionStore();
    const sessionId = await seedCompletedSession(sessions);
    globalThis.fetch = mock(async () => missingCheckpointResponse());
    const capture = captureOperation('run-recovery-failed');
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig({ sessions }));

    await expect(runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: sessionId,
      nativeSession: sessions.nativeReference(sessionId),
      command: 'retry once',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: capture.operation,
    })).rejects.toThrow('previous response cannot be resolved');

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((await sessions.load(sessionId)).records.filter((record) => record.type === 'assistant'))
      .toHaveLength(1);
  });

  it('does not retry unrelated failures or checkpoint errors after output', async () => {
    for (const scenario of ['unrelated', 'after-output']) {
      const sessions = createTestDirectSessionStore();
      const sessionId = await seedCompletedSession(sessions);
      globalThis.fetch = scenario === 'unrelated'
        ? mock(async () => Response.json({
            error: { code: 'rate_limit_exceeded', message: 'rate limited' },
          }, { status: 429 }))
        : mock(async () => streamResponse([
            { type: 'response.output_text.delta', delta: 'partial' },
            {
              type: 'error',
              error: {
                code: 'previous_response_not_found',
                message: 'checkpoint disappeared after output',
              },
            },
          ], { complete: false }));
      const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig({ sessions }));

      await expect(runtime.runTurn({
        chatId: 'chat-1',
        agentSessionId: sessionId,
        nativeSession: sessions.nativeReference(sessionId),
        command: `${scenario} message`,
        projectPath: '/tmp/project',
        model: 'selected-model',
        permissionMode: 'default',
        thinkingMode: 'none',
        operation: captureOperation(`run-${scenario}`).operation,
      })).rejects.toThrow();

      expect(globalThis.fetch, scenario).toHaveBeenCalledTimes(1);
      const assistants = (await sessions.load(sessionId)).records.filter(
        (record) => record.type === 'assistant',
      );
      expect(assistants, scenario).toHaveLength(1);
      expect(assistants[0].checkpoint, scenario).toEqual(checkpoint());
      runtime.shutdown();
    }
  });

  it('falls back to full local history after a completion without an ID', async () => {
    const requestBodies = [];
    globalThis.fetch = mock(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return streamResponse([
        { type: 'response.output_text.delta', delta: `response ${requestBodies.length}` },
      ], requestBodies.length === 1 ? {} : { responseId: 'resp-second' });
    });
    const config = runtimeConfig();
    const runtime = new OpenAiCompatibleResponsesRuntime(config);
    const first = captureOperation('run-first');
    const started = await runtime.startSession({
      chatId: 'chat-1',
      command: 'first message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: first.operation,
    });
    await first.terminal;

    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: started.agentSessionId,
      nativeSession: started.nativeSession,
      command: 'second message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: captureOperation('run-second').operation,
    });

    expect(requestBodies[1]).toMatchObject({
      input: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'response 1' },
        { role: 'user', content: 'second message' },
      ],
      previous_response_id: null,
    });
  });

  it('accepts a buffered JSON response for an interactive Responses session', async () => {
    globalThis.fetch = mock(async () => Response.json({
      id: 'resp-json',
      output_text: 'session response',
    }));
    const config = runtimeConfig();
    const runtime = new OpenAiCompatibleResponsesRuntime(config);
    const capture = captureOperation('run-json');

    const started = await runtime.startSession({
      chatId: 'chat-json',
      command: 'hi',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      operation: capture.operation,
    });

    await capture.terminal;
    expect(capturedMessages(capture)).toMatchObject([{ content: 'session response' }]);
    expect((await config.sessions.load(started.agentSessionId)).records.at(-1)?.checkpoint)
      .toEqual(checkpoint({ responseId: 'resp-json' }));
  });

  it('does not emit partial session output after a stream failure', async () => {
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.failed', response: { error: { message: 'failed' } } },
    ], { complete: false }));
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig());
    const capture = captureOperation('run-failed');

    await runtime.startSession({
      chatId: 'chat-failed',
      command: 'hi',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      operation: capture.operation,
    });

    await expect(capture.terminal.then((event) => event.error?.message)).resolves.toBe(
      'Direct (Responses) stream error: failed',
    );
    expect(capturedMessages(capture)).toEqual([]);
  });

  it('forwards the current interactive effort and removes it for Default', async () => {
    const requestBodies = [];
    globalThis.fetch = mock(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return streamResponse([
        { type: 'response.output_text.delta', delta: 'done' },
      ]);
    });
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig());
    const first = captureOperation('run-first');

    const started = await runtime.startSession({
      chatId: 'chat-1',
      command: 'first',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'high',
      claudeThinkingMode: 'auto',
      operation: first.operation,
    });
    await first.terminal;

    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: started.agentSessionId,
      nativeSession: started.nativeSession,
      command: 'second',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'low',
      claudeThinkingMode: 'auto',
      operation: captureOperation('run-second').operation,
    });
    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: started.agentSessionId,
      nativeSession: started.nativeSession,
      command: 'third',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      operation: captureOperation('run-third').operation,
    });

    expect(requestBodies[0].reasoning).toEqual({ effort: 'high' });
    expect(requestBodies[1].reasoning).toEqual({ effort: 'low' });
    expect(requestBodies[2]).not.toHaveProperty('reasoning');
    expect(requestBodies.every((body) => (
      body.stream === true
      && body.store === true
      && body.previous_response_id === null
    ))).toBe(true);
  });

  it('hydrates an unknown session from persisted native history', async () => {
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

    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return streamResponse([
        { type: 'response.output_text.delta', delta: 'second response' },
      ]);
    });

    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig({ sessions }));
    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: sessionId,
      nativeSession: sessions.nativeReference(sessionId),
      command: 'second message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'max',
      claudeThinkingMode: 'auto',
      operation: captureOperation('run-hydrated').operation,
    });

    expect(requestBody.reasoning).toEqual({ effort: 'max' });
    expect(requestBody.previous_response_id).toBeNull();
    expect(requestBody.store).toBe(true);
    expect(requestBody.input).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second message' },
    ]);
  });
});
