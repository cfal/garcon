import { expect, test } from 'bun:test';
import { ChatExecutionControlOperations } from '../chat-execution-control-operations.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.js';

test('discarding a dequeue preserves earlier dispatch receipts without adding one for the discard', async () => {
  const controls = new ChatExecutionControlOperations(new InMemoryChatExecutionControlRepository('instance'), {
    runExclusive: (_chatId, operation) => operation(),
    chatExists: () => true,
    unsettledQueueReceiptKeys: () => new Set(),
    publish() {},
  }, { assertAvailable: async () => {} }, { assertSupported() {} });
  const chatId = 'chat-1';
  const first = await controls.create(chatId, { content: 'first input', images: [] });
  await controls.create(chatId, { content: 'second input', images: [] });
  await controls.dequeueNextTurn(chatId, () => 'inserted');
  const before = (await controls.read(chatId)).recentlyDispatched;
  expect(before.map(receipt => receipt.entryId)).toEqual([first.entryId]);

  await controls.dequeueNextTurn(chatId, () => 'discarded');
  const after = await controls.read(chatId);
  expect(after.entries).toEqual([]);
  expect(after.recentlyDispatched).toEqual(before);
});
