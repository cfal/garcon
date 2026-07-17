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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-anthropic-runtime-'));
  createdDirs.push(dir);
  return dir;
}

function makeRuntime(dir, overrides = {}) {
  return new AnthropicCompatibleChatRuntime({
    runtimeId: 'direct-anthropic-compatible',
    runtimeLabel: 'Direct (Anthropic)',
    defaultModel: 'acme-sonnet',
    fallbackModels: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
    getApiKey: () => 'sk-ant',
    getBaseUrl: () => 'https://api.example.test',
    getSessionDir: () => dir,
    getSessionFilePath: (id) => path.join(dir, `${id}.jsonl`),
    ...overrides,
  });
}

function waitForMessages(runtime) {
  return new Promise((resolve) => {
    runtime.onMessages((_chatId, messages) => resolve(messages));
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
    expect(messages[0].content).toBe('hello world');
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
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    expect(requestBody.messages).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second message' },
    ]);
    expect(requestBody.model).toBe('selected-model');
  });

  it('runs one-shot prompts through non-streaming Anthropic Messages', async () => {
    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        content: [
          { type: 'text', text: 'commit' },
          { type: 'text', text: ' message' },
        ],
      }));
    });

    const result = await runAnthropicCompatibleSingleQuery({
      runtimeId: 'direct-anthropic-compatible',
      runtimeLabel: 'Direct (Anthropic)',
      defaultModel: 'acme-sonnet',
      fallbackModels: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
      getApiKey: () => 'sk-ant',
      getBaseUrl: () => 'https://api.example.test',
      getSessionDir: () => '/tmp/unused',
      getSessionFilePath: (id) => `/tmp/unused/${id}.jsonl`,
    }, 'Generate a commit message', { model: 'acme-opus' });

    expect(result).toBe('commit message');
    expect(requestBody).toEqual({
      model: 'acme-opus',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Generate a commit message' }],
    });
  });

  it('rejects explicit generic one-shot effort before provider work', async () => {
    const fetchMock = mock(() => Promise.resolve(Response.json({ content: [] })));
    globalThis.fetch = fetchMock;

    await expect(runAnthropicCompatibleSingleQuery({
      runtimeId: 'direct-anthropic-compatible',
      runtimeLabel: 'Direct (Anthropic)',
      defaultModel: 'acme-sonnet',
      fallbackModels: [],
      getApiKey: () => 'sk-ant',
      getBaseUrl: () => 'https://api.example.test',
      getSessionDir: () => '/tmp/unused',
      getSessionFilePath: (id) => `/tmp/unused/${id}.jsonl`,
    }, 'test', { thinkingMode: 'high' })).rejects.toThrow(
      'direct-anthropic-compatible does not support explicit one-shot effort high',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
