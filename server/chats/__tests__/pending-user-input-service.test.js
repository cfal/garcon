import { describe, expect, it, mock } from 'bun:test';
import { PendingUserInputService } from '../pending-user-input-service.js';

function createReader() {
  return {
    ensureLoaded: mock(() => Promise.resolve([])),
    getMessages: mock(() => []),
  };
}

describe('PendingUserInputService', () => {
  it('discards a chat without emitting clear events', async () => {
    const service = new PendingUserInputService(createReader());
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
    const service = new PendingUserInputService(createReader());
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
    const service = new PendingUserInputService(createReader());
    const updated = [];
    const cleared = [];
    service.store.onUpdated((input) => {
      updated.push(input);
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
    expect(updated.at(-1)).toMatchObject({
      clientRequestId: 'req-1',
      deliveryStatus: 'failed',
    });
    expect(cleared).toEqual([]);
  });
});
