import { expect, test } from 'bun:test';
import { MessageQueueBudget } from '../message-queue-budget.js';
import { MessageSession } from '../message-session.js';
import { RpcAdmission } from '../rpc-admission.js';

test('shared admission reserves primary capacity and releases exactly once', () => {
  const admission = new RpcAdmission(4, 3);
  const bulk = Array.from({ length: 3 }, () => admission.acquire('bulk'));
  expect(() => admission.acquire('bulk')).toThrow('too many requests');
  const primary = admission.acquire('primary');
  expect(admission.size).toBe(4);
  expect(() => admission.acquire('primary')).toThrow();
  bulk[0]!();
  bulk[0]!();
  expect(admission.size).toBe(3);
  primary();
  for (const release of bulk) release();
  expect(admission.size).toBe(0);
});

test('full ordinary queues cannot retire primary through bulk controls', async () => {
  const budget = new MessageQueueBudget({
    bytes: 1000, messages: 8, bulkBytes: 600, bulkMessages: 4, controlBytes: 200, controlMessages: 2,
  });
  let failures = 0;
  const primary = new MessageSession({ deliver() {}, failed() { failures++; }, budget, lane: 'primary' });
  const bulk = new MessageSession({ deliver() {}, failed() { failures++; }, budget, lane: 'bulk' });
  const socket = () => ({ send() {}, close() {}, canSend: () => false });
  primary.attach(socket());
  bulk.attach(socket());
  bulk.send('b'.repeat(600));
  expect(bulk.canAdmit('b')).toBe(false);
  primary.send('p'.repeat(200));
  expect(primary.canAdmit('p')).toBe(false);
  const frame = { type: 'bulk-prepare', sessionId: crypto.randomUUID() } as const;
  expect(primary.offerBulkControl(frame)).toBe(true);
  expect(primary.offerBulkControl(frame)).toBe(true);
  expect(primary.offerBulkControl(frame)).toBe(false);
  expect(primary.connected).toBe(true);
  expect(failures).toBe(0);
  expect(budget.queuedMessages).toBe(4);
  let notifications = 0;
  const unsubscribe = primary.onCapacity(() => notifications++);
  bulk.close();
  await Promise.resolve();
  expect(notifications).toBe(1);
  expect(primary.connected).toBe(true);
  expect(primary.canAdmit('p')).toBe(true);
  unsubscribe();
  primary.close();
  expect(budget.queuedBytes).toBe(0);
  expect(budget.queuedMessages).toBe(0);
});

test('terminal offers refuse aggregate pressure without retiring their primary session', () => {
  const budget = new MessageQueueBudget({
    bytes: 1000, messages: 8, bulkBytes: 800, bulkMessages: 4, controlBytes: 200, controlMessages: 2,
  });
  let failures = 0;
  const primary = new MessageSession({ deliver() {}, failed() { failures++; }, budget, lane: 'primary' });
  primary.attach({ send() {}, close() {}, canSend: () => true });
  const release = budget.reserve('bulk', 800);
  expect(primary.trySend('terminal output')).toBe(false);
  expect(failures).toBe(0);
  expect(primary.connected).toBe(true);
  release();
  expect(primary.trySend('terminal output')).toBe(true);
  primary.close();
});
