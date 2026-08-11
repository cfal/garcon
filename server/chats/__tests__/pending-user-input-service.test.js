import { describe, expect, it } from 'bun:test';
import { PendingUserInputService } from '../pending-user-input-service.js';

// Settlement is identity-based: a record clears only when the projection
// reports its client-request identity bound to proven provider-native
// evidence, and a stop-captured cohort that cannot prove persistence is
// marked unconfirmed rather than cleared.
function createService(initialSettled = []) {
  const settled = new Set(initialSettled);
  const reads = [];
  let gate = null;
  const service = new PendingUserInputService({
    async settledInputRequests(chatId) {
      reads.push(chatId);
      if (gate) await gate.promise;
      if (settledError) throw settledError;
      return new Set(settled);
    },
  });
  let settledError = null;
  return {
    service,
    settled,
    reads,
    failWith(error) { settledError = error; },
    holdReads() {
      let resolve;
      const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
      gate = { promise };
      return () => { gate = null; resolve(); };
    },
  };
}

describe('PendingUserInputService', () => {
  it('classifies pending delivery lifecycle for chat idleness', async () => {
    const { service } = createService();

    expect(service.hasInFlightForChat('missing-chat')).toBe(false);

    for (const [deliveryStatus, expected] of [
      ['submitting', true],
      ['accepted', true],
      ['unconfirmed', false],
      ['failed', false],
    ]) {
      const chatId = `chat-${deliveryStatus}`;
      await service.register(chatId, deliveryStatus, {
        clientRequestId: `req-${deliveryStatus}`,
        deliveryStatus,
      });
      expect(service.hasInFlightForChat(chatId)).toBe(expected);
    }

    await service.register('chat-terminal', 'unconfirmed', {
      clientRequestId: 'req-unconfirmed',
      deliveryStatus: 'unconfirmed',
    });
    await service.register('chat-terminal', 'failed', {
      clientRequestId: 'req-failed',
      deliveryStatus: 'failed',
    });
    expect(service.hasInFlightForChat('chat-terminal')).toBe(false);

    await service.register('chat-terminal', 'accepted', {
      clientRequestId: 'req-accepted',
      deliveryStatus: 'accepted',
    });
    expect(service.hasInFlightForChat('chat-terminal')).toBe(true);
  });

  it('discards a chat without emitting clear events', async () => {
    const { service } = createService();
    const cleared = [];
    service.store.onCleared((chatId, clientRequestId, reason) => {
      cleared.push({ chatId, clientRequestId, reason });
    });

    await service.register('chat-1', 'hello', { clientRequestId: 'req-1' });

    expect(service.listForChat('chat-1')).toHaveLength(1);
    expect(service.discardChat('chat-1')).toBe(1);
    expect(service.listForChat('chat-1')).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it('discards one input without emitting a clear event', async () => {
    const { service } = createService();
    const cleared = [];
    service.store.onCleared((chatId, clientRequestId, reason) => {
      cleared.push({ chatId, clientRequestId, reason });
    });

    await service.register('chat-1', 'first', { clientRequestId: 'req-1' });
    await service.register('chat-1', 'second', { clientRequestId: 'req-2' });

    expect(service.discard('chat-1', 'req-1')).toBe(true);
    expect(service.listForChat('chat-1').map((input) => input.clientRequestId)).toEqual(['req-2']);
    expect(cleared).toEqual([]);
  });

  it('marks one input failed without clearing the overlay', async () => {
    const { service } = createService();
    const statusUpdated = [];
    const cleared = [];
    service.store.onStatusUpdated((chatId, clientRequestId, deliveryStatus) => {
      statusUpdated.push({ chatId, clientRequestId, deliveryStatus });
    });
    service.store.onCleared((chatId, clientRequestId, reason) => {
      cleared.push({ chatId, clientRequestId, reason });
    });

    await service.register('chat-1', 'first', { clientRequestId: 'req-1' });
    expect(service.markFailed('chat-1', 'req-1')).toBe(true);
    expect(service.listForChat('chat-1')).toMatchObject([{
      clientRequestId: 'req-1',
      deliveryStatus: 'failed',
    }]);
    expect(statusUpdated).toEqual([{
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      deliveryStatus: 'failed',
    }]);
    expect(cleared).toEqual([]);
  });

  it('clears records whose identity is bound to proven native evidence', async () => {
    const { service, settled } = createService();
    await service.register('chat-1', 'first', { clientRequestId: 'req-1' });
    await service.register('chat-1', 'second', { clientRequestId: 'req-2' });

    settled.add('req-1');
    await service.reconcileNativeHistory('chat-1');
    expect(service.listForChat('chat-1').map((input) => input.clientRequestId)).toEqual(['req-2']);

    settled.add('req-2');
    await service.reconcileRetainedHistory('chat-1');
    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('never clears by content: an equal-content foreign identity stays pending', async () => {
    const { service, settled } = createService();
    settled.add('some-other-request');
    await service.register('chat-1', 'same text', { clientRequestId: 'req-1' });
    await service.reconcileNativeHistory('chat-1');
    expect(service.listForChat('chat-1')).toMatchObject([{ clientRequestId: 'req-1' }]);
  });

  it('settles a stopped cohort: proven identities clear, the rest go unconfirmed', async () => {
    const { service, settled } = createService();
    await service.register('chat-1', 'delivered', { clientRequestId: 'req-delivered' });
    await service.register('chat-1', 'queued', { clientRequestId: 'req-queued' });
    await service.register('chat-1', 'failed', {
      clientRequestId: 'req-failed',
      deliveryStatus: 'failed',
    });
    const cohort = service.captureCohort('chat-1');

    settled.add('req-delivered');
    await service.settleNativeCohort(cohort);

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-queued', deliveryStatus: 'unconfirmed' },
      { clientRequestId: 'req-failed', deliveryStatus: 'failed' },
    ]);
  });

  it('does not settle an input registered after the cohort was captured', async () => {
    const { service } = createService();
    await service.register('chat-1', 'stopped input', { clientRequestId: 'req-stopped' });
    const cohort = service.captureCohort('chat-1');
    await service.register('chat-1', 'next input', { clientRequestId: 'req-next' });

    await service.settleNativeCohort(cohort);

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-stopped', deliveryStatus: 'unconfirmed' },
      { clientRequestId: 'req-next', deliveryStatus: 'accepted' },
    ]);
  });

  it('marks a cohort unconfirmed when the settlement read degrades', async () => {
    const { service, failWith } = createService();
    await service.register('chat-1', 'input', { clientRequestId: 'req-1' });
    const cohort = service.captureCohort('chat-1');
    failWith(new Error('projection unavailable'));

    await service.settleNativeCohort(cohort);

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-1', deliveryStatus: 'unconfirmed' },
    ]);
  });

  it('coalesces repeated native reconciliation into one dirty rerun', async () => {
    const { service, settled, reads, holdReads } = createService();
    await service.register('chat-1', 'input', { clientRequestId: 'req-1' });

    await service.register('chat-1', 'still pending', { clientRequestId: 'req-2' });
    reads.length = 0;
    const release = holdReads();
    const first = service.reconcileNativeHistory('chat-1');
    const second = service.reconcileNativeHistory('chat-1');
    const third = service.reconcileNativeHistory('chat-1');
    settled.add('req-1');
    release();
    await Promise.all([first, second, third]);

    expect(service.listForChat('chat-1')).toMatchObject([{ clientRequestId: 'req-2' }]);
    // One held read plus exactly one dirty rerun.
    expect(reads).toEqual(['chat-1', 'chat-1']);
  });

  it('clears a failed input when a later read proves persistence', async () => {
    const { service, settled } = createService();
    await service.register('chat-1', 'input', { clientRequestId: 'req-1' });
    service.markFailed('chat-1', 'req-1');

    settled.add('req-1');
    await service.reconcileNativeHistory('chat-1');
    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('reads nothing when a chat has no pending records', async () => {
    const { service, reads } = createService();
    await service.reconcileNativeHistory('chat-1');
    await service.reconcileRetainedHistory('chat-1');
    expect(reads).toEqual([]);
  });
});
