import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OpenAiCompatibleResponsesRuntime,
  buildOpenAiResponsesUserContent,
  consumeResponsesStreamEvent,
  extractOpenAiResponsesTextContent,
  extractResponsesOutputText,
  runOpenAiResponsesSingleQuery,
} from '../openai-compatible-responses-runtime.ts';

const createdDirs = [];
const originalFetch = globalThis.fetch;

function streamResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  const events = options.complete === false
    ? chunks
    : [...chunks, { type: 'response.completed', response: { status: 'completed' } }];
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

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-openai-responses-runtime-'));
  createdDirs.push(dir);
  return dir;
}

function runtimeConfig(dir, overrides = {}) {
  return {
    runtimeId: 'direct-openai-responses-compatible',
    runtimeLabel: 'Direct (Responses)',
    defaultModel: 'fallback-model',
    fallbackModels: [{ value: 'fallback-model', label: 'Fallback' }],
    getApiKey: () => 'sk-test',
    getBaseUrl: () => 'https://api.example.test/v1',
    getSessionDir: () => dir,
    getSessionFilePath: (id) => path.join(dir, `${id}.jsonl`),
    ...overrides,
  };
}

function waitForMessages(runtime) {
  return new Promise((resolve) => {
    runtime.onMessages((_chatId, messages) => resolve(messages));
  });
}

describe('OpenAiCompatibleResponsesRuntime', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
    const state = { text: 'hel', errorMessage: null, terminal: null };
    consumeResponsesStreamEvent(state, {
      type: 'response.output_text.delta',
      delta: 'lo',
    });
    expect(state).toEqual({ text: 'hello', errorMessage: null, terminal: null });

    consumeResponsesStreamEvent(state, {
      type: 'response.failed',
      response: { status_details: { error: { message: 'bad request' } } },
    });
    expect(state).toEqual({
      text: 'hello',
      errorMessage: 'bad request',
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
        { type: 'response.output_text.delta', delta: 'single' },
        { type: 'response.output_text.delta', delta: ' response' },
      ]);
    });

    const dir = await tempDir();
    const result = await runOpenAiResponsesSingleQuery(runtimeConfig(dir), 'hi', {
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
        content: [{ type: 'output_text', text: 'buffered response' }],
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

  it('streams Direct Responses turns and persists assistant text', async () => {
    const dir = await tempDir();
    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return streamResponse([
        { type: 'response.output_text.delta', delta: 'hello' },
        { type: 'response.output_text.delta', delta: ' world' },
      ]);
    });

    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig(dir));
    const messagesPromise = new Promise((resolve) => {
      runtime.onMessages((chatId, messages) => resolve({ chatId, messages }));
    });

    const started = await runtime.startSession({
      chatId: 'chat-1',
      command: 'hi',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });
    const emitted = await messagesPromise;

    expect(started.nativePath).toBe(path.join(dir, `${started.agentSessionId}.jsonl`));
    await fs.access(started.nativePath);
    expect(requestBody).toEqual({
      model: 'selected-model',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
      store: false,
    });
    expect(emitted.chatId).toBe('chat-1');
    expect(emitted.messages[0].content).toBe('hello world');

    const persisted = await fs.readFile(path.join(dir, `${started.agentSessionId}.jsonl`), 'utf8');
    expect(persisted).toContain('"content":"hi"');
    expect(persisted).toContain('"content":"hello world"');
  });

  it('accepts a buffered JSON response for an interactive Responses session', async () => {
    const dir = await tempDir();
    globalThis.fetch = mock(async () => Response.json({ output_text: 'session response' }));
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig(dir));
    const messages = waitForMessages(runtime);

    await runtime.startSession({
      chatId: 'chat-json',
      command: 'hi',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    await expect(messages).resolves.toMatchObject([{ content: 'session response' }]);
  });

  it('does not emit or persist partial session output after a stream failure', async () => {
    const dir = await tempDir();
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.failed', response: { error: { message: 'failed' } } },
    ], { complete: false }));
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig(dir));
    const emitted = mock(() => {});
    runtime.onMessages(emitted);
    const failure = new Promise((resolve) => runtime.onFailed((_chatId, message) => resolve(message)));

    const started = await runtime.startSession({
      chatId: 'chat-failed',
      command: 'hi',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    await expect(failure).resolves.toBe('Direct (Responses) stream error: failed');
    expect(emitted).not.toHaveBeenCalled();
    const persisted = await fs.readFile(started.nativePath, 'utf8');
    expect(persisted).toContain('"content":"hi"');
    expect(persisted).not.toContain('partial');
  });

  it('forwards the current interactive effort and removes it for Default', async () => {
    const dir = await tempDir();
    const requestBodies = [];
    globalThis.fetch = mock(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return streamResponse([
        { type: 'response.output_text.delta', delta: 'done' },
      ]);
    });
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig(dir));
    const firstMessages = waitForMessages(runtime);

    const started = await runtime.startSession({
      chatId: 'chat-1',
      command: 'first',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'high',
      claudeThinkingMode: 'auto',
    });
    await firstMessages;

    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: started.agentSessionId,
      command: 'second',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'low',
      claudeThinkingMode: 'auto',
    });
    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: started.agentSessionId,
      command: 'third',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    expect(requestBodies[0].reasoning).toEqual({ effort: 'high' });
    expect(requestBodies[1].reasoning).toEqual({ effort: 'low' });
    expect(requestBodies[2]).not.toHaveProperty('reasoning');
    expect(requestBodies.every((body) => body.stream === true && body.store === false)).toBe(true);
  });

  it('does not start provider work when the initial transcript cannot be persisted', async () => {
    const root = await tempDir();
    const blockedParent = path.join(root, 'blocked');
    const sessionDir = path.join(blockedParent, 'sessions');
    await fs.writeFile(blockedParent, 'not a directory');
    const fetchMock = mock(async () => streamResponse([]));
    globalThis.fetch = fetchMock;

    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig(sessionDir));
    const sessionCreated = mock(() => {});
    runtime.onSessionCreated(sessionCreated);

    await expect(runtime.startSession({
      chatId: 'chat-1',
      command: 'hi',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    })).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionCreated).not.toHaveBeenCalled();
    expect(runtime.getRunningSessions()).toEqual([]);
  });

  it('marks resumed turns running before persistence and clears the state on failure', async () => {
    const root = await tempDir();
    let activeDir = root;
    const fetchMock = mock(async () => streamResponse([
      { type: 'response.output_text.delta', delta: 'first response' },
    ]));
    globalThis.fetch = fetchMock;
    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig(root, {
      getSessionDir: () => activeDir,
      getSessionFilePath: (id) => path.join(activeDir, `${id}.jsonl`),
    }));
    const firstResponse = new Promise((resolve) => runtime.onMessages(resolve));
    const processing = mock(() => {});
    runtime.onProcessing(processing);

    const started = await runtime.startSession({
      chatId: 'chat-1',
      command: 'first',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });
    await firstResponse;
    processing.mockClear();

    const blockedParent = path.join(root, 'blocked');
    await fs.writeFile(blockedParent, 'not a directory');
    activeDir = path.join(blockedParent, 'sessions');

    await expect(runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: started.agentSessionId,
      command: 'second',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    })).rejects.toThrow();

    expect(processing.mock.calls.map((call) => call[1])).toEqual([true, false]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runtime.isRunning(started.agentSessionId)).toBe(false);
  });

  it('hydrates an unknown session from persisted JSONL before resuming', async () => {
    const dir = await tempDir();
    const sessionId = 'persisted-session';
    await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), [
      JSON.stringify({ role: 'user', content: 'first message' }),
      JSON.stringify({ role: 'assistant', content: 'first response' }),
      '',
    ].join('\n'));

    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return streamResponse([
        { type: 'response.output_text.delta', delta: 'second response' },
      ]);
    });

    const runtime = new OpenAiCompatibleResponsesRuntime(runtimeConfig(dir));
    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: sessionId,
      command: 'second message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'max',
      claudeThinkingMode: 'auto',
    });

    expect(requestBody.reasoning).toEqual({ effort: 'max' });
    expect(requestBody.input).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second message' },
    ]);
  });
});
