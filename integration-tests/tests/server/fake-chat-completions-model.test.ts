import { describe, expect, test } from 'bun:test';
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
