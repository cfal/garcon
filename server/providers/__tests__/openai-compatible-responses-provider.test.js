import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OpenAiCompatibleResponsesProvider,
  applyResponsesStreamEvent,
  buildOpenAiResponsesUserContent,
  extractOpenAiResponsesTextContent,
  extractResponsesOutputText,
  runOpenAiResponsesSingleQuery,
} from '../openai-compatible-responses-provider.ts';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-openai-responses-provider-'));
  createdDirs.push(dir);
  return dir;
}

function providerConfig(dir) {
  return {
    providerId: 'direct-openai-responses-compatible',
    providerLabel: 'Direct (Responses)',
    defaultModel: 'fallback-model',
    fallbackModels: [{ value: 'fallback-model', label: 'Fallback' }],
    getApiKey: () => 'sk-test',
    getBaseUrl: () => 'https://api.example.test/v1',
    getSessionDir: () => dir,
    getSessionFilePath: (id) => path.join(dir, `${id}.jsonl`),
  };
}

describe('OpenAiCompatibleResponsesProvider', () => {
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
    const result = await runOpenAiResponsesSingleQuery(providerConfig(dir), 'hi', {
      model: 'selected-model',
    });

    expect(result).toBe('single response');
    expect(requestUrl).toBe('https://api.example.test/v1/responses');
    expect(requestBody).toEqual({
      model: 'selected-model',
      input: [{ role: 'user', content: 'hi' }],
      store: false,
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

    const provider = new OpenAiCompatibleResponsesProvider(providerConfig(dir));
    const messagesPromise = new Promise((resolve) => {
      provider.onMessages((chatId, messages) => resolve({ chatId, messages }));
    });

    const started = await provider.startSession({
      chatId: 'chat-1',
      command: 'hi',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });
    const emitted = await messagesPromise;

    expect(started.nativePath).toBe(`!direct-openai-responses-compatible:${started.providerSessionId}`);
    expect(requestBody).toEqual({
      model: 'selected-model',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
      store: false,
    });
    expect(emitted.chatId).toBe('chat-1');
    expect(emitted.messages[0].content).toBe('hello world');

    const persisted = await fs.readFile(path.join(dir, `${started.providerSessionId}.jsonl`), 'utf8');
    expect(persisted).toContain('"content":"hi"');
    expect(persisted).toContain('"content":"hello world"');
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

    const provider = new OpenAiCompatibleResponsesProvider(providerConfig(dir));
    await provider.runTurn({
      chatId: 'chat-1',
      providerSessionId: sessionId,
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
