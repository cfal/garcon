import { expect, test } from 'bun:test';
import { RpcReplyJournal, type RpcJournalOwner } from '../rpc-journal.js';
import type { RpcLane } from '../rpc-lane.js';

const UNKNOWN = 'unknown-outcome';

function owner(session: string, accepting = true, lane: RpcLane = 'primary') {
  const offered: string[] = [];
  const state = { accepting };
  const value: RpcJournalOwner & { offered: string[]; state: typeof state } = {
    session, lane, offered, state,
    offer(payload) {
      if (!state.accepting) return false;
      offered.push(payload);
      return true;
    },
  };
  return value;
}

test('delivers a reply to the owning session and releases it once acknowledged', () => {
  const journal = new RpcReplyJournal();
  const first = owner('session-1');
  const call = journal.begin(first, 'call-1');
  expect(journal.running).toBe(1);
  journal.complete(call, 'reply-1', UNKNOWN);

  expect(first.offered).toEqual(['reply-1']);
  expect(journal.running).toBe(0);
  journal.acknowledge(first, ['call-1']);
  expect(journal.has('call-1')).toBe(false);
});

test('reconciles running, completed, never-received, and forgotten calls of a lost session', () => {
  const journal = new RpcReplyJournal();
  const first = owner('session-1');
  journal.received(first, 1);
  const running = journal.begin(first, 'running');
  journal.received(first, 2);
  const completed = journal.begin(first, 'completed');
  journal.received(first, 3);
  const abandoned = journal.begin(first, 'abandoned');
  journal.complete(completed, 'completed-reply', UNKNOWN);
  journal.ownerLost(first);
  const second = owner('session-2');

  expect(journal.reconcile(second, [
    { id: 'running', session: 'session-1', seq: 1 },
    { id: 'completed', session: 'session-1', seq: 2 },
    { id: 'lost-request', session: 'session-1', seq: 4 },
    { id: 'forgotten', session: 'session-1', seq: 3 },
    { id: 'other-session', session: 'session-0', seq: 9 },
  ])).toEqual([
    { id: 'running', state: 'pending' },
    { id: 'completed', state: 'pending' },
    { id: 'lost-request', state: 'not-received' },
    { id: 'forgotten', state: 'unknown' },
    { id: 'other-session', state: 'unknown' },
  ]);
  // The caller of an unclaimed call gave up, so it is cancelled and never answered.
  expect(abandoned.signal.aborted).toBe(true);
  expect(running.signal.aborted).toBe(false);

  journal.deliver();
  expect(second.offered).toEqual(['completed-reply']);
  journal.complete(running, 'running-reply', UNKNOWN);
  journal.complete(abandoned, 'abandoned-reply', UNKNOWN);
  expect(second.offered).toEqual(['completed-reply', 'running-reply']);
  expect(first.offered).toEqual(['completed-reply']);
  expect(journal.has('abandoned')).toBe(false);
});

test('offers a refused reply again and redelivers one sent to a lost session', async () => {
  const journal = new RpcReplyJournal();
  const first = owner('session-1', false);
  const call = journal.begin(first, 'call-1');
  journal.complete(call, 'reply-1', UNKNOWN);
  expect(first.offered).toEqual([]);
  first.state.accepting = true;
  await Bun.sleep(30);
  expect(first.offered).toEqual(['reply-1']);

  journal.ownerLost(first);
  const second = owner('session-2');
  expect(journal.reconcile(second, [{ id: 'call-1', session: 'session-1', seq: 1 }])).toEqual([{ id: 'call-1', state: 'pending' }]);
  journal.deliver();
  expect(second.offered).toEqual(['reply-1']);
  journal.dispose();
});

test('drops the oldest delivered replies first under pressure, which then reconcile as unknown', () => {
  const journal = new RpcReplyJournal({ retainedBytes: 20 });
  const first = owner('session-1');
  journal.received(first, 3);
  const delivered = journal.begin(first, 'delivered');
  journal.complete(delivered, 'x'.repeat(10), UNKNOWN);
  first.state.accepting = false;
  const waiting = journal.begin(first, 'waiting');
  journal.complete(waiting, 'y'.repeat(10), UNKNOWN);
  const newest = journal.begin(first, 'newest');
  journal.complete(newest, 'z'.repeat(10), UNKNOWN);
  journal.ownerLost(first);

  expect(journal.reconcile(owner('session-2'), [
    { id: 'delivered', session: 'session-1', seq: 1 },
    { id: 'waiting', session: 'session-1', seq: 2 },
    { id: 'newest', session: 'session-1', seq: 3 },
  ]).map(({ state }) => state)).toEqual(['unknown', 'pending', 'pending']);
  journal.dispose();
});

test('a cancelled call is aborted and its reply dropped', () => {
  const journal = new RpcReplyJournal();
  const first = owner('session-1');
  const call = journal.begin(first, 'call-1');
  journal.cancel(first, 'call-1');
  expect(call.signal.aborted).toBe(true);
  journal.complete(call, 'reply-1', UNKNOWN);
  expect(first.offered).toEqual([]);
  expect(journal.has('call-1')).toBe(false);
  expect(journal.running).toBe(0);
});

test('answers a waiting session with an unknown outcome when pressure drops its undelivered reply', () => {
  const journal = new RpcReplyJournal({ retainedBytes: 25 });
  const first = owner('session-1', false);
  const waiting = journal.begin(first, 'waiting');
  journal.complete(waiting, 'y'.repeat(20), UNKNOWN);
  const newest = journal.begin(first, 'newest');
  journal.complete(newest, 'z'.repeat(10), UNKNOWN);
  first.state.accepting = true;
  journal.deliver();

  expect(first.offered).toEqual([UNKNOWN, 'z'.repeat(10)]);
  journal.dispose();
});

test('forgets an undelivered reply of a lost session under pressure, which then reconciles as unknown', () => {
  const journal = new RpcReplyJournal({ retainedBytes: 30 });
  const first = owner('session-1', false);
  journal.received(first, 2);
  const lost = journal.begin(first, 'lost');
  journal.complete(lost, 'y'.repeat(20), UNKNOWN);
  journal.ownerLost(first);
  const second = owner('session-2');
  const newest = journal.begin(second, 'newest');
  journal.complete(newest, 'z'.repeat(20), UNKNOWN);

  expect(journal.reconcile(second, [{ id: 'lost', session: 'session-1', seq: 1 }])).toEqual([{ id: 'lost', state: 'unknown' }]);
  expect(second.offered).toEqual(['z'.repeat(20)]);
  journal.dispose();
});

test('bulk recovery neither cancels nor claims primary work', () => {
  const journal = new RpcReplyJournal();
  const primary = owner('primary');
  const bulk = owner('bulk', true, 'bulk');
  journal.received(primary, 1);
  journal.received(bulk, 1);
  const control = journal.begin(primary, 'control');
  const transfer = journal.begin(bulk, 'transfer');
  journal.ownerLost(primary);
  journal.ownerLost(bulk);
  const replacement = owner('new-bulk', true, 'bulk');
  expect(journal.reconcile(replacement, [{ id: 'transfer', session: 'bulk', seq: 1 }])).toEqual([{ id: 'transfer', state: 'pending' }]);
  expect(control.signal.aborted).toBe(false);
  expect(() => journal.reconcile(replacement, [{ id: 'control', session: 'primary', seq: 1 }])).toThrow('ownership mismatch');
  expect(() => journal.reconcile(replacement, [{ id: 'absent', session: 'primary', seq: 2 }])).toThrow('ownership mismatch');
  journal.cancel(primary, 'transfer');
  expect(transfer.signal.aborted).toBe(false);
  journal.complete(transfer, 'reply', UNKNOWN);
  journal.acknowledge(primary, ['transfer']);
  expect(journal.has('transfer')).toBe(true);
  journal.acknowledge(replacement, ['transfer']);
  expect(journal.has('transfer')).toBe(false);
  journal.dispose();
});

test('blocked bulk delivery and retention cannot consume primary reservations', () => {
  const journal = new RpcReplyJournal({ retainedBytes: 100, bulkRetainedBytes: 75 });
  const bulk = owner('bulk', false, 'bulk');
  const primary = owner('primary');
  journal.complete(journal.begin(bulk, 'bulk-1'), 'b'.repeat(70), UNKNOWN);
  journal.complete(journal.begin(primary, 'primary-1'), 'p'.repeat(25), UNKNOWN);
  expect(primary.offered).toEqual(['p'.repeat(25)]);
  journal.complete(journal.begin(bulk, 'bulk-2'), 'c'.repeat(70), UNKNOWN);
  expect(journal.has('primary-1')).toBe(true);
  journal.dispose();
});

test('bulk flaps do not evict primary receipt history', () => {
  const journal = new RpcReplyJournal();
  journal.received(owner('primary'), 1);
  for (let i = 0; i < 32; i++) journal.received(owner(`bulk-${i}`, true, 'bulk'), 1);
  expect(journal.reconcile(owner('new-primary'), [{ id: 'not-sent', session: 'primary', seq: 2 }])).toEqual([{ id: 'not-sent', state: 'not-received' }]);
  journal.dispose();
});
