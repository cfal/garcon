import { describe, expect, it } from 'bun:test';
import { ChatExecutionControlOperations } from '../chat-execution-control-operations.ts';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.ts';

describe('ChatExecutionControlOperations', () => {
  it('returns a committed steering reservation when publication fails', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    let publicationFails = false;
    const operations = new ChatExecutionControlOperations(repository, {
      runExclusive: (_chatId, operation) => operation(),
      chatExists: () => true,
      unsettledQueueReceiptKeys: () => new Set(),
      publish: () => {
        if (publicationFails) throw new Error('listener failed');
      },
    });
    const created = await operations.create('chat-1', 'queued guidance');
    publicationFails = true;

    const reserved = await operations.reserveSteer('chat-1', {
      entryId: created.entryId,
      expectedRevision: 1,
      expectedReorderRevision: 0,
    });

    expect(reserved.entry.status).toBe('steering');
    expect((await repository.load('chat-1')).entries).toContainEqual(
      expect.objectContaining({ id: created.entryId, status: 'steering' }),
    );
  });
});
