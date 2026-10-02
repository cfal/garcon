import { expect, test, mock } from 'bun:test';
import { createCarriedContext } from '../carried-context.js';
import { PreparedCarryoverStore } from '../prepared-carryover.js';

function input() {
  return {
    chatId: 'chat-1', transcriptViewId: 'view-1', clientRequestId: 'request-1',
    entry: { agentId: 'synthetic', executorId: 'local', agentOwnershipEpoch: 'epoch-1' },
    messages: [], destinationPrompt: 'synthetic prompt',
    signal: new AbortController().signal, onCompactionStarted() {},
  };
}

test('uses matching prepared context once before consulting compaction', async () => {
  const prepared = new PreparedCarryoverStore();
  const result = { kind: 'complete', context: { prefix: 'synthetic context' } };
  prepared.deposit({
    chatId: 'chat-1', transcriptViewId: 'view-1', clientRequestId: 'request-1',
    targetAgentId: 'synthetic', targetExecutorId: 'local', targetOwnershipEpoch: 'epoch-1', result,
  });
  expect(await createCarriedContext(input(), prepared, null)).toBe(result);
  await expect(createCarriedContext(input(), prepared, null)).rejects.toThrow('not initialized');
});

test('passes the captured destination, transcript, and cancellation to fresh-start planning', async () => {
  const request = input();
  const result = { kind: 'complete', context: null };
  const planFor = mock(async () => result);
  expect(await createCarriedContext(request, new PreparedCarryoverStore(), { planFor })).toBe(result);
  expect(planFor).toHaveBeenCalledWith({
    operation: 'fresh-start', chatId: request.chatId, messages: request.messages,
    destination: { agentId: 'synthetic', model: '', prompt: request.destinationPrompt },
    signal: request.signal, onCompactionStarted: request.onCompactionStarted,
  });
});
