import { expect, test, mock } from 'bun:test';
import { createCarriedContext } from '../context.js';
import { PreparedCarryoverStore } from '../prepared-store.js';

function input() {
  return {
    chatId: 'chat-1', transcriptViewId: 'view-1', clientRequestId: 'request-1',
    entry: { agentId: 'synthetic', executorId: 'local', agentOwnershipEpoch: 'epoch-1' },
    readMessages: mock(async () => []), destinationPrompt: 'synthetic prompt',
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
  const request = input();
  expect(await createCarriedContext(request, prepared, null)).toBe(result);
  expect(request.readMessages).not.toHaveBeenCalled();
  await expect(createCarriedContext(request, prepared, null)).rejects.toThrow('not initialized');
  expect(request.readMessages).not.toHaveBeenCalled();
});

test('passes the captured destination, transcript, and cancellation to fresh-start planning', async () => {
  const request = input();
  const result = { kind: 'no-history' };
  const planFor = mock(async () => result);
  expect(await createCarriedContext(request, new PreparedCarryoverStore(), { planFor })).toBe(result);
  expect(planFor).toHaveBeenCalledWith({
    operation: 'fresh-start', chatId: request.chatId, messages: [],
    destination: { agentId: 'synthetic', model: '', prompt: request.destinationPrompt },
    signal: request.signal, onCompactionStarted: request.onCompactionStarted,
  });
  expect(request.readMessages).toHaveBeenCalledTimes(1);
});

test('reads current history when the prepared handoff ownership fence does not match', async () => {
  const request = input();
  const prepared = new PreparedCarryoverStore();
  prepared.deposit({
    chatId: request.chatId, transcriptViewId: request.transcriptViewId,
    clientRequestId: request.clientRequestId, targetAgentId: request.entry.agentId,
    targetExecutorId: request.entry.executorId, targetOwnershipEpoch: 'stale-epoch',
    result: { kind: 'complete', context: { prefix: 'stale context' } },
  });
  const result = { kind: 'no-history' };
  const planFor = mock(async () => result);

  expect(await createCarriedContext(request, prepared, { planFor })).toBe(result);
  expect(request.readMessages).toHaveBeenCalledTimes(1);
  expect(planFor).toHaveBeenCalledTimes(1);
});

test('does not read history or consume prepared context for an already cancelled start', async () => {
  const request = input();
  const controller = new AbortController();
  const reason = new Error('Synthetic cancelled start');
  controller.abort(reason);
  const prepared = new PreparedCarryoverStore();
  const take = mock(prepared.take.bind(prepared));
  prepared.take = take;
  const planFor = mock(async () => ({ kind: 'no-history' }));

  await expect(createCarriedContext({ ...request, signal: controller.signal }, prepared, { planFor }))
    .rejects.toBe(reason);
  expect(take).not.toHaveBeenCalled();
  expect(request.readMessages).not.toHaveBeenCalled();
  expect(planFor).not.toHaveBeenCalled();
});

test('does not start compaction when cancellation arrives during the history read', async () => {
  const controller = new AbortController();
  const reason = new Error('Synthetic interrupted history read');
  const request = {
    ...input(), signal: controller.signal,
    readMessages: mock(async () => {
      controller.abort(reason);
      return [];
    }),
  };
  const planFor = mock(async () => ({ kind: 'no-history' }));

  await expect(createCarriedContext(request, new PreparedCarryoverStore(), { planFor }))
    .rejects.toBe(reason);
  expect(request.readMessages).toHaveBeenCalledTimes(1);
  expect(planFor).not.toHaveBeenCalled();
});

test('propagates history read failure without invoking compaction', async () => {
  const reason = new Error('Synthetic unavailable transcript');
  const request = { ...input(), readMessages: mock(async () => { throw reason; }) };
  const planFor = mock(async () => ({ kind: 'no-history' }));

  await expect(createCarriedContext(request, new PreparedCarryoverStore(), { planFor }))
    .rejects.toBe(reason);
  expect(planFor).not.toHaveBeenCalled();
});
