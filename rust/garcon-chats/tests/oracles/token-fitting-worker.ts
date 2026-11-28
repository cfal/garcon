import assert from 'node:assert/strict';
import {
  AssistantMessage, BashToolUseMessage, TranscriptNoticeMessage, UserMessage,
} from '../../../../common/chat-types.js';
import { TokenFittingWorker } from '../../../../server/controller/chats/token-fitting/client.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);
const time = '2026-01-01T00:00:00.000Z';
const destination = { agentId: 'claude', model: 'synthetic-model', prompt: '<Keep> going' };
const summary = 'Synthetic compaction summary & next step.';
const worker = new TokenFittingWorker();

function history(turns: number, words: number) {
  return [
    new TranscriptNoticeMessage(time, 'Synthetic output lost', { type: 'publication-gap' }),
    ...Array.from({ length: turns }, (_, index) => [
      new UserMessage(time, `Request ${index}`),
      new BashToolUseMessage(time, `tool-${index}`, `run --step ${index}`),
      new AssistantMessage(time, `Result ${index}: ${'zebra     piano'.repeat(words)}`),
    ]).flat(),
  ];
}

try {
  const cases = [];
  for (const [turns, words, window, maximumEntryBudget] of [
    [2, 10, 32_768, null],
    [150, 80, 32_768, null],
    [20, 320, 1_024, null],
    [30, 20, 32_768, 1_024],
  ] as const) {
    const messages = history(turns, words);
    const assessment = await worker.assessCarryover(messages);
    const fitted = await worker.fitCompactionPrompt({
      messages, destination, contextWindowTokens: window, maximumEntryBudgetTokens: maximumEntryBudget,
    });
    const projection = await worker.projectCompactedCarryover(messages, summary);
    assert.ok(projection.prefix.includes('<publication-gap>'));
    cases.push({ messages, destination, window, maximumEntryBudget, summary, assessment, fitted, projection });
  }
  assert.deepEqual(cases.map(({ fitted }) => fitted.kind), ['unavailable', 'fitted', 'unavailable', 'fitted']);
  process.stdout.write(JSON.stringify(cases));
} finally {
  worker.close();
}
