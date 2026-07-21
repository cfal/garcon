import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AnthropicCompatibleChatRuntime,
  anthropicMessagesUrl,
  buildAnthropicCompatibleHeaders,
  buildAnthropicCompatibleUserContent,
  runAnthropicCompatibleSingleQuery,
} from '../anthropic-compatible-chat-runtime.ts';

const originalFetch = globalThis.fetch;
const createdDirs = [];

function streamResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  const events = options.complete === false
    ? chunks
    : [...chunks, { type: 'message_stop' }];
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-anthropic-runtime-'));
  createdDirs.push(dir);
  return dir;
}

function runtimeConfig(dir, overrides = {}) {
  return {
    runtimeId: 'direct-anthropic-compatible',
    runtimeLabel: 'Direct (Anthropic)',
    defaultModel: 'acme-sonnet',
    fallbackModels: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
    getApiKey: () => 'sk-ant',
    getBaseUrl: () => 'https://api.example.test',
    getSessionDir: () => dir,
    getSessionFilePath: (id) => path.join(dir, `${id}.jsonl`),
    ...overrides,
  };
}

function makeRuntime(dir, overrides = {}) {
  return new AnthropicCompatibleChatRuntime(runtimeConfig(dir, overrides));
}

function waitForMessages(runtime) {
  return new Promise((resolve) => {
    runtime.onMessages((_chatId, messages) => resolve(messages));
  });
}

function waitForFailure(runtime) {
  return new Promise((resolve) => {
    runtime.onFailed((_chatId, message) => resolve(message));
  });
}

describe('AnthropicCompatibleChatRuntime', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('builds Anthropic endpoint URLs from root and v1 base URLs', () => {
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropicMessagesUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropicMessagesUrl('https://api.example.test/custom/')).toBe('https://api.example.test/custom/v1/messages');
  });

  it('builds Anthropic headers and omits x-api-key when blank', () => {
    expect(buildAnthropicCompatibleHeaders('sk-ant')).toEqual({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    expect(buildAnthropicCompatibleHeaders('')).toEqual({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
  });

  it('maps data URL images to Anthropic content blocks', () => {
    expect(buildAnthropicCompatibleUserContent('describe', [{
      name: 'image.png',
      data: 'data:image/png;base64,abc123',
    }])).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'abc123',
        },
      },
      { type: 'text', text: 'describe' },
    ]);
  });

  it('maps PDF attachments to Anthropic document content blocks', () => {
    expect(buildAnthropicCompatibleUserContent('summarize', [{
      name: 'report.pdf',
      mimeType: 'application/pdf',
      data: 'data:application/pdf;base64,JVBERi0x',
    }])).toEqual([
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'JVBERi0x',
        },
        title: 'report.pdf',
      },
      { type: 'text', text: 'summarize' },
    ]);
  });

  it('inlines markdown attachments as text and keeps a plain-string content', () => {
    expect(buildAnthropicCompatibleUserContent('read this', [{
      name: 'notes.md',
      mimeType: 'text/markdown',
      data: `data:text/markdown;base64,${Buffer.from('# Title\nbody').toString('base64')}`,
    }])).toBe([
      'read this',
      '<attached-file name="notes.md" mime="text/markdown">\n# Title\nbody\n\n</attached-file>',
    ].join('\n\n'));
  });

  it('streams text deltas and emits the final assistant message', async () => {
    const dir = await tempDir();
    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return streamResponse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      ]);
    });

    const runtime = makeRuntime(dir);
    const messagesPromise = waitForMessages(runtime);

    await runtime.startSession({
      chatId: 'chat-1',
      command: 'hello?',
      projectPath: '/tmp/project',
      model: 'acme-sonnet',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    const messages = await messagesPromise;
    expect(requestBody).toMatchObject({
      model: 'acme-sonnet',
      max_tokens: 4096,
      stream: true,
      messages: [{ role: 'user', content: 'hello?' }],
    });
    expect(requestBody).not.toHaveProperty('output_config');
    expect(requestBody).not.toHaveProperty('thinking');
    expect(messages[0].content).toBe('hello world');
  });

  it('accepts buffered JSON for an interactive Anthropic session', async () => {
    const dir = await tempDir();
    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'session response' },
        ],
      });
    });
    const runtime = makeRuntime(dir);
    const messages = waitForMessages(runtime);

    await runtime.startSession({
      chatId: 'chat-json',
      command: 'hello',
      projectPath: '/tmp/project',
      model: 'acme-sonnet',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    expect(requestBody.stream).toBe(true);
    await expect(messages).resolves.toMatchObject([{ content: 'session response' }]);
  });

  it('forwards the current interactive effort and removes it for Default', async () => {
    const dir = await tempDir();
    const requestBodies = [];
    globalThis.fetch = mock(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return streamResponse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
      ]);
    });
    const runtime = makeRuntime(dir);
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

    expect(requestBodies[0].output_config).toEqual({ effort: 'high' });
    expect(requestBodies[1].output_config).toEqual({ effort: 'low' });
    expect(requestBodies[2]).not.toHaveProperty('output_config');
    expect(requestBodies.every((body) => !Object.hasOwn(body, 'thinking'))).toBe(true);
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
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'second response' } },
      ]);
    });

    const runtime = makeRuntime(dir, {
      defaultModel: 'fallback-model',
      fallbackModels: [{ value: 'fallback-model', label: 'Fallback' }],
    });

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

    expect(requestBody.messages).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second message' },
    ]);
    expect(requestBody.model).toBe('selected-model');
    expect(requestBody.output_config).toEqual({ effort: 'max' });
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('streams one-shot prompts through Anthropic Messages', async () => {
    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return streamResponse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'commit' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' message' } },
      ]);
    });

    const result = await runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'Generate a commit message',
      { model: 'acme-opus' },
    );

    expect(result).toBe('commit message');
    expect(requestBody).toEqual({
      model: 'acme-opus',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Generate a commit message' }],
      stream: true,
    });
    expect(requestBody).not.toHaveProperty('output_config');
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('forwards explicit one-shot effort through Anthropic output_config', async () => {
    let requestBody;
    const fetchMock = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({ content: [{ type: 'text', text: 'OK' }] });
    });
    globalThis.fetch = fetchMock;

    const result = await runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
      { thinkingMode: 'max' },
    );

    expect(result).toBe('OK');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody.stream).toBe(true);
    expect(requestBody.output_config).toEqual({ effort: 'max' });
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('does not retry a provider-rejected effort', async () => {
    const fetchMock = mock(async () => new Response('unsupported effort', { status: 400 }));
    globalThis.fetch = fetchMock;

    await expect(runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
      { thinkingMode: 'ultra' },
    )).rejects.toThrow('Direct (Anthropic) API error 400: unsupported effort');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores one-shot thinking and signature deltas before visible text', async () => {
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'secret' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'visible' } },
    ]));

    await expect(runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
    )).resolves.toBe('visible');
  });

  it('returns no visible one-shot text for a completed thinking-only stream', async () => {
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } },
    ]));

    await expect(runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
    )).resolves.toBe('');
  });

  it('accepts buffered JSON when Anthropic ignores the streaming request', async () => {
    globalThis.fetch = mock(async () => Response.json({
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'visible' },
      ],
    }));

    await expect(runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
    )).resolves.toBe('visible');
  });

  it('rejects partial one-shot text followed by an Anthropic error event', async () => {
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      { type: 'error', error: { message: 'generation failed' } },
    ]));

    await expect(runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
    )).rejects.toThrow('Direct (Anthropic) stream error: generation failed');
  });

  it('rejects a one-shot stream that closes before message_stop', async () => {
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    ], { complete: false }));

    await expect(runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
    )).rejects.toThrow('Direct (Anthropic) stream ended before message_stop.');
  });

  it('skips malformed one-shot events before valid text and message_stop', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {malformed}\n\n'));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'valid' },
        })}\n\n`));
        controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    }), {
      headers: { 'content-type': 'text/event-stream' },
    }));

    await expect(runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
    )).resolves.toBe('valid');
  });

  it('preserves caller abort while reading a one-shot stream', async () => {
    const externalController = new AbortController();
    const encoder = new TextEncoder();
    let markBodyStarted;
    const bodyStarted = new Promise((resolve) => {
      markBodyStarted = resolve;
    });
    globalThis.fetch = mock(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial' },
        })}\n\n`));
        init.signal.addEventListener('abort', () => {
          controller.error(init.signal.reason);
        }, { once: true });
        markBodyStarted();
      },
    }), {
      headers: { 'content-type': 'text/event-stream' },
    }));

    const result = runAnthropicCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'test',
      { signal: externalController.signal },
    );
    await bodyStarted;
    externalController.abort(new DOMException('Stopped', 'AbortError'));

    await expect(result).rejects.toThrow('Stopped');
  });

  it('rejects partial streamed text followed by an Anthropic error event', async () => {
    const dir = await tempDir();
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      { type: 'error', error: { message: 'generation failed' } },
    ]));
    const runtime = makeRuntime(dir);
    const failure = waitForFailure(runtime);

    await runtime.startSession({
      chatId: 'chat-error',
      command: 'fail',
      projectPath: '/tmp/project',
      model: 'acme-sonnet',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    await expect(failure).resolves.toBe(
      'Direct (Anthropic) stream error: generation failed',
    );
  });

  it('rejects a valid partial stream that closes before message_stop', async () => {
    const dir = await tempDir();
    globalThis.fetch = mock(async () => streamResponse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    ], { complete: false }));
    const runtime = makeRuntime(dir);
    const failure = waitForFailure(runtime);

    await runtime.startSession({
      chatId: 'chat-truncated',
      command: 'truncate',
      projectPath: '/tmp/project',
      model: 'acme-sonnet',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    await expect(failure).resolves.toBe(
      'Direct (Anthropic) stream ended before message_stop.',
    );
  });
});
