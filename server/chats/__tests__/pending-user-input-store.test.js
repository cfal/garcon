import { describe, expect, it } from 'bun:test';
import { PendingUserInputStore } from '../pending-user-input-store.js';

function input(content = 'message') {
  return {
    chatId: 'chat-1',
    clientRequestId: 'req-1',
    content,
    createdAt: '2026-06-01T00:00:00.000Z',
    deliveryStatus: 'accepted',
  };
}

describe('PendingUserInputStore cohort identity', () => {
  it('keeps record identity across delivery-status updates', () => {
    const store = new PendingUserInputStore();
    store.upsert(input());
    const record = store.listRecordsForChat('chat-1')[0];

    expect(store.updateDeliveryStatusIfCurrent('chat-1', record, 'unconfirmed')).toBe(true);
    expect(store.isCurrentRecord('chat-1', record)).toBe(true);
    expect(record.deliveryStatus).toBe('unconfirmed');
  });

  it('replaces record identity on upsert and rejects stale cohort mutations', () => {
    const store = new PendingUserInputStore();
    store.upsert(input('first version'));
    const staleRecord = store.listRecordsForChat('chat-1')[0];

    store.upsert(input('replacement version'));
    const currentRecord = store.listRecordsForChat('chat-1')[0];

    expect(currentRecord).not.toBe(staleRecord);
    expect(store.isCurrentRecord('chat-1', staleRecord)).toBe(false);
    expect(store.updateDeliveryStatusIfCurrent('chat-1', staleRecord, 'failed')).toBe(false);
    expect(store.listForChat('chat-1')).toMatchObject([{
      content: 'replacement version',
      deliveryStatus: 'accepted',
    }]);
  });
});
