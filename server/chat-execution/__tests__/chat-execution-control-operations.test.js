import { describe, expect, it, mock } from 'bun:test';
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

  it('commits private control mutations without publishing public queue revisions', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const publish = mock(() => undefined);
    const operations = new ChatExecutionControlOperations(repository, {
      runExclusive: (_chatId, operation) => operation(),
      chatExists: () => true,
      unsettledQueueReceiptKeys: () => new Set(),
      publish,
    });
    const input = {
      content: '<garcon-message>\nmessage\n</garcon-message>',
      transcriptViewId: 'view-1',
      createdAt: '2026-08-29T00:00:00.000Z',
      receipt: {
        title: 'Inter-agent message',
        content: 'message',
        detail: { type: 'inter-agent-message-received', fromChatId: null },
      },
    };

    const queued = await operations.enqueueControl('chat-1', input);
    expect(queued.control.controlEntries).toHaveLength(1);
    expect(queued.control.version).toBe(0);
    expect(publish).not.toHaveBeenCalled();

    const dequeued = await operations.dequeueNextTurn('chat-1', (turn) => {
      expect(turn).toMatchObject({ kind: 'control', entry: input });
      return true;
    });
    expect(dequeued?.input.kind).toBe('control');
    expect(dequeued?.control.controlEntries).toEqual([]);
    expect(dequeued?.control.version).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});
