import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenAiCompatibleChatRuntime } from '../direct/openai-compatible-chat-runtime.ts';

const createdDirs = [];
const originalFetch = globalThis.fetch;

function streamResponse(content) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-openai-runtime-'));
  createdDirs.push(dir);
  return dir;
}

function runtimeConfig(dir) {
  return {
    runtimeId: 'direct-openai-compatible',
    runtimeLabel: 'Direct (Chat Completions)',
    defaultModel: 'fallback-model',
    fallbackModels: [{ value: 'fallback-model', label: 'Fallback' }],
    getApiKey: () => 'sk-test',
    getBaseUrl: () => 'https://api.example.test/v1',
    getSessionDir: () => dir,
    getSessionFilePath: (id) => path.join(dir, `${id}.jsonl`),
  };
}

describe('OpenAiCompatibleChatRuntime', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
      return streamResponse('second response');
    });

    const runtime = new OpenAiCompatibleChatRuntime(runtimeConfig(dir));

    await runtime.runTurn({
      chatId: '123',
      agentSessionId: sessionId,
      command: 'second message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });

    expect(requestBody.model).toBe('selected-model');
    expect(requestBody.messages).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second message' },
    ]);
  });

  it('marks direct sessions idle before emitting finished', async () => {
    const dir = await tempDir();
    const sessionId = 'known-session';
    await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), [
      JSON.stringify({ role: 'user', content: 'first message' }),
      '',
    ].join('\n'));
    globalThis.fetch = mock(async () => streamResponse('done'));
    const runtime = new OpenAiCompatibleChatRuntime(runtimeConfig(dir));
    let runningWhenFinished;
    const finished = new Promise((resolve) => {
      runtime.onFinished(() => {
        runningWhenFinished = runtime.isRunning(sessionId);
        resolve();
      });
    });

    await runtime.runTurn({
      chatId: 'chat-1',
      agentSessionId: sessionId,
      command: 'hello',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
    });
    await finished;

    expect(runningWhenFinished).toBe(false);
  });
});
