import { expect, test } from 'bun:test';
import { runBombadilCampaign } from '../../support/bombadil-fixture.js';
import { terminalOutcomesMatch } from '../../bombadil/settlement.js';
import { AgentRunFailedMessage, AgentRunFinishedMessage } from '../../../common/ws-events.js';

test('seeded navigation preserves canonical transcripts and dispatch counts', () => runBombadilCampaign('navigation'), 180_000);
test('click and Enter each dispatch exactly one committed turn', () => runBombadilCampaign('submission'), 180_000);
test('held output survives reload; queue edits and removal precede targeted Stop', () => runBombadilCampaign('queue'), 180_000);
test('production Svelte assets remain usable with instrumentation', () => runBombadilCampaign('navigation', true), 180_000);

test('settlement rejects missing, duplicate, wrong-turn and failed-after-reply terminals', () => {
  const expected = [{ chatId: 'chat', turnId: 'turn', outcome: 'finished' as const }];
  const finished = new AgentRunFinishedMessage('chat', 0, 'turn', undefined, undefined, 'finished');
  const otherFinished = new AgentRunFinishedMessage('chat', 0, 'other-turn', undefined, undefined, 'finished');
  const failed = new AgentRunFailedMessage('chat', 'Failure after reply', 'turn');
  const otherFailed = new AgentRunFailedMessage('chat', 'Unmatched failure', 'other-turn');
  const interrupted = new AgentRunFinishedMessage('chat', 0, 'turn', undefined, undefined, 'interrupted');
  expect(terminalOutcomesMatch(expected, [finished])).toBe(true);
  expect(terminalOutcomesMatch(expected, [])).toBe(false);
  expect(terminalOutcomesMatch(expected, [finished, finished])).toBe(false);
  expect(terminalOutcomesMatch(expected, [finished, otherFinished])).toBe(false);
  expect(terminalOutcomesMatch([...expected, ...expected], [finished, otherFailed])).toBe(false);
  expect(terminalOutcomesMatch(expected, [failed])).toBe(false);
  expect(terminalOutcomesMatch(expected, [otherFinished])).toBe(false);
  expect(terminalOutcomesMatch(expected, [interrupted])).toBe(false);
});
