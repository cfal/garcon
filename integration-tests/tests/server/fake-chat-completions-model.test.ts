import { describe, expect, test } from 'bun:test';
import { rejectionOf } from '../../support/promise-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
  FakeChatCompletionsModel,
} from '../../support/fake-chat-completions-model.js';

const DEFAULT_USAGE = {
  prompt_tokens: 42,
  completion_tokens: 7,
  total_tokens: 49,
};
const OVERRIDE_USAGE = {
  prompt_tokens: 94_000,
  completion_tokens: 1_000,
  total_tokens: 95_000,
};

describe('FakeChatCompletionsModel usage scripting', () => {
  test('stalls after an initial SSE chunk until the caller aborts', async () => {
    const model = FakeChatCompletionsModel.start();
    const controller = new AbortController();
    try {
      model.scriptFault({ kind: 'stream-stall' });
      const response = await fetch(`${model.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'scripted-model', stream: true, messages: [] }),
        signal: controller.signal,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('chat.completion.chunk');
      expect(new TextDecoder().decode(first.value)).not.toContain('[DONE]');
      const next = reader.read();
      controller.abort();
      expect(await rejectionOf(next)).toBeInstanceOf(Error);
      const request = model.requests()[0]!;
      const deadline = Date.now() + 2_000;
      while (request.abortedAt === null && Date.now() < deadline) await Bun.sleep(10);
      expect(request.abortedAt).not.toBeNull();
      model.assertSettled();
    } finally {
      controller.abort();
      model.stop();
    }
  });

  test('streams raw malformed tool arguments without JSON normalization', async () => {
    const model = FakeChatCompletionsModel.start();
    const rawArguments = '{"path":"synthetic.txt","invalid":.5}';
    try {
      model.scriptTurn([chatCompletionsToolUse('invalid', 'write', {}, { rawArguments })]);
      const response = await fetch(`${model.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'scripted-model', stream: true, messages: [] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(JSON.stringify({ arguments: rawArguments }));
      model.assertSettled();
    } finally {
      model.stop();
    }
  });

  test('preserves default usage and applies text and tool-call overrides', async () => {
    const model = FakeChatCompletionsModel.start();
    try {
      model.scriptTurn([chatCompletionsText('default')]);
      model.scriptTurn([chatCompletionsText('override', { usage: OVERRIDE_USAGE })]);
      model.scriptTurn([chatCompletionsToolUse(
        'call-usage',
        'bash',
        { command: 'printf synthetic' },
        { usage: OVERRIDE_USAGE },
      )]);

      expect(await requestUsage(model, 'default')).toEqual(DEFAULT_USAGE);
      expect(await requestUsage(model, 'text override')).toEqual(OVERRIDE_USAGE);
      expect(await requestUsage(model, 'tool override')).toEqual(OVERRIDE_USAGE);
      model.assertSettled();
    } finally {
      model.stop();
    }
  });
});

async function requestUsage(
  model: FakeChatCompletionsModel,
  content: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${model.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'scripted-model',
      stream: true,
      messages: [{ role: 'user', content }],
    }),
  });
  expect(response.status).toBe(200);
  const frames = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
  const usage = frames.findLast((frame) => frame.usage !== undefined)?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error('Scripted completion omitted its final usage');
  }
  return usage as Record<string, unknown>;
}
