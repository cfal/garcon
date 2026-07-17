import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OpenAiCompatibleResponsesRuntime,
  applyResponsesStreamEvent,
  buildOpenAiResponsesUserContent,
  extractOpenAiResponsesTextContent,
  extractResponsesOutputText,
  runOpenAiResponsesSingleQuery,
} from '../openai-compatible-responses-runtime.ts';

const createdDirs = [];
const originalFetch = globalThis.fetch;

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
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

  it('applies streaming deltas and stream errors', () => {
    expect(applyResponsesStreamEvent('hel', {
      type: 'response.output_text.delta',
      delta: 'lo',
    })).toEqual({ text: 'hello' });
    expect(applyResponsesStreamEvent('', {
      type: 'response.failed',
      response: { status_details: { error: { message: 'bad request' } } },
    })).toEqual({ text: '', error: 'bad request' });
  });

  it('posts single queries to /responses and extracts output text', async () => {
    let requestUrl = '';
    let requestBody;
    globalThis.fetch = mock(async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(init.body);
      return Response.json({ output_text: 'single response' });
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
      store: false,
      reasoning: { effort: 'ultra' },
    });
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
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    expect(requestBody.input).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second message' },
    ]);
  });
});
