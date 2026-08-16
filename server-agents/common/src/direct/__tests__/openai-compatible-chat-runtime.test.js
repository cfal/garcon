import { afterEach, describe, expect, it, mock } from 'bun:test';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import {
  OpenAiCompatibleChatRuntime,
  runOpenAiCompatibleSingleQuery,
} from '../openai-compatible-chat-runtime.ts';

const originalFetch = globalThis.fetch;

function streamResponse(...contents) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const content of contents) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function runtimeConfig() {
  return {
    runtimeLabel: 'Direct (Chat Completions)',
    defaultModel: 'fallback-model',
    getApiKey: () => 'sk-test',
    getBaseUrl: () => 'https://api.example.test/v1',
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

describe('OpenAiCompatibleChatRuntime', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
  });

  it('hydrates an unknown session from the supplied ledger context', async () => {
    const sessionId = 'persisted-session';

    let requestBody;
    globalThis.fetch = mock(async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return streamResponse('second response');
    });

    const runtime = new OpenAiCompatibleChatRuntime(runtimeConfig());

    await runtime.runTurn({
      chatId: '123',
      agentSessionId: sessionId,
      command: 'second message',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'max',
      claudeThinkingMode: 'auto',
      priorContext: [
        new UserMessage('2026-01-01T00:00:00.000Z', 'first message'),
        new AssistantMessage('2026-01-01T00:00:01.000Z', 'first response'),
      ],
      operation: captureOperation('run-hydrate').operation,
    });

    expect(requestBody.model).toBe('selected-model');
    expect(requestBody.reasoning_effort).toBe('max');
    expect(requestBody.messages).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'second message' },
    ]);
  });

  it('marks direct sessions idle before emitting finished', async () => {
    const sessionId = 'known-session';
    globalThis.fetch = mock(async () => streamResponse('done'));
    const runtime = new OpenAiCompatibleChatRuntime(runtimeConfig());
    let runningWhenFinished;
    const capture = captureOperation('run-known');
    const finished = capture.terminal.then(() => {
        runningWhenFinished = runtime.isRunning(sessionId);
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
      operation: capture.operation,
    });
    await finished;

    expect(runningWhenFinished).toBe(false);
  });

  it('forwards the current interactive effort and removes it for Default', async () => {
    const requestBodies = [];
    globalThis.fetch = mock(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return streamResponse('done');
    });
    const runtime = new OpenAiCompatibleChatRuntime(runtimeConfig());
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
      command: 'third',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      operation: captureOperation('run-third').operation,
    });

    expect(requestBodies[0].reasoning_effort).toBe('high');
    expect(requestBodies[1].reasoning_effort).toBe('low');
    expect(requestBodies[2]).not.toHaveProperty('reasoning_effort');
    expect(requestBodies.every((body) => body.stream === true)).toBe(true);
  });

  it('forwards explicit one-shot effort and omits provider Default', async () => {
    const requestBodies = [];
    globalThis.fetch = mock(async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return streamResponse('OK');
    });

    await runOpenAiCompatibleSingleQuery(runtimeConfig('/tmp/unused'), 'test', {
      model: 'glm-5.2',
      thinkingMode: 'max',
      timeoutMs: 110_000,
    });
    await runOpenAiCompatibleSingleQuery(runtimeConfig('/tmp/unused'), 'test', {
      model: 'glm-5.2',
      thinkingMode: 'none',
    });

    expect(requestBodies[0]).toEqual({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
      reasoning_effort: 'max',
    });
    expect(requestBodies[1]).not.toHaveProperty('reasoning_effort');
    expect(requestBodies[1].stream).toBe(true);
  });

  it('aggregates streamed one-shot response chunks before returning', async () => {
    globalThis.fetch = mock(async () => streamResponse(
      '<thi',
      'nk>private reasoning',
      '</think>',
      '\n generated',
      ' message ',
    ));

    const result = await runOpenAiCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'Describe the change.',
      { model: 'reasoning-model' },
    );

    expect(result).toBe('generated message');
  });

  it('accepts a buffered JSON response from providers that ignore streaming', async () => {
    globalThis.fetch = mock(async () => Response.json({
      choices: [{ message: { content: '<think>private</think>\n generated message ' } }],
    }));

    const result = await runOpenAiCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'Describe the change.',
      { model: 'reasoning-model' },
    );

    expect(result).toBe('generated message');
  });

  it('strips think blocks before emitting interactive text', async () => {
    globalThis.fetch = mock(async () => streamResponse(
      '<think>private',
      ' reasoning</think>',
      '\n visible response ',
    ));
    const runtime = new OpenAiCompatibleChatRuntime(runtimeConfig());
    const capture = captureOperation('run-think');

    await runtime.startSession({
      chatId: 'chat-think',
      command: 'hello',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      operation: capture.operation,
    });

    await capture.terminal;
    expect(capturedMessages(capture)).toMatchObject([{ content: 'visible response' }]);
  });

  it('accepts a buffered JSON response for an interactive session', async () => {
    globalThis.fetch = mock(async () => Response.json({
      choices: [{ message: { content: 'session response' } }],
    }));
    const runtime = new OpenAiCompatibleChatRuntime(runtimeConfig());
    const capture = captureOperation('run-json');

    await runtime.startSession({
      chatId: 'chat-json',
      command: 'hello',
      projectPath: '/tmp/project',
      model: 'selected-model',
      permissionMode: 'default',
      thinkingMode: 'none',
      claudeThinkingMode: 'auto',
      operation: capture.operation,
    });

    await capture.terminal;
    expect(capturedMessages(capture)).toMatchObject([{ content: 'session response' }]);
  });

  it('ignores reasoning-only deltas before visible one-shot content', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: 'hidden' } }],
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{ delta: { content: 'visible' } }],
        })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), {
      headers: { 'content-type': 'text/event-stream' },
    }));

    await expect(runOpenAiCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'Describe the change.',
    )).resolves.toBe('visible');
  });

  it('surfaces a provider error from an empty one-shot stream', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ error: { message: 'request rejected' } })}\n\n`,
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    })));

    await expect(runOpenAiCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'Describe the change.',
    )).rejects.toThrow('Direct (Chat Completions) stream error: request rejected');
  });

  it('rejects partial one-shot output followed by a provider stream error', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
        ));
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ error: { message: 'generation failed' } })}\n\n`,
        ));
        controller.close();
      },
    })));

    await expect(runOpenAiCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'Describe the change.',
    )).rejects.toThrow('Direct (Chat Completions) stream error: generation failed');
  });

  it('rejects a valid partial stream that closes before the completion sentinel', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
        ));
        controller.close();
      },
    })));

    await expect(runOpenAiCompatibleSingleQuery(
      runtimeConfig('/tmp/unused'),
      'Describe the change.',
    )).rejects.toThrow('Direct (Chat Completions) stream ended before [DONE]');
  });
});
