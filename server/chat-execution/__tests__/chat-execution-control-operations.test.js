import { describe, expect, it, mock } from 'bun:test';
import { ChatExecutionControlOperations } from '../chat-execution-control-operations.ts';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.ts';
import { ProjectUnavailableError } from '../../lib/domain-error.ts';

function host() {
  return {
    runExclusive: (_chatId, operation) => operation(),
    chatExists: () => true,
    unsettledQueueReceiptKeys: () => new Set(),
    publish: () => undefined,
  };
}

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
    }, { assertAvailable: mock(async () => undefined) });
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
    }, { assertAvailable: mock(async () => undefined) });
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

  it('checks project availability before committing a new queue entry', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const unavailable = new ProjectUnavailableError('/workspace/missing', 'not-found');
    const operations = new ChatExecutionControlOperations(
      repository,
      host(),
      { assertAvailable: mock(async () => { throw unavailable; }) },
    );

    await expect(operations.create(
      'chat-1',
      'queued work',
      { key: 'command-1', entryId: 'entry-1' },
    )).rejects.toBe(unavailable);

    expect(await repository.load('chat-1')).toMatchObject({
      version: 0,
      entries: [],
      appliedCommands: [],
    });
  });

  it('checks project availability before committing private control input', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const unavailable = new ProjectUnavailableError('/workspace/missing', 'not-found');
    const operations = new ChatExecutionControlOperations(
      repository,
      host(),
      { assertAvailable: mock(async () => { throw unavailable; }) },
    );

    await expect(operations.enqueueControl('chat-1', {
      content: '<garcon-message>message</garcon-message>',
      transcriptViewId: 'view-1',
      createdAt: '2026-08-29T00:00:00.000Z',
      receipt: {
        title: 'Inter-agent message',
        content: 'message',
        detail: { type: 'inter-agent-message-received', fromChatId: null },
      },
    })).rejects.toBe(unavailable);

    expect((await repository.load('chat-1')).controlEntries).toEqual([]);
  });

  it('does not recheck project availability for a duplicate queue command', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const assertAvailable = mock(async () => undefined);
    const operations = new ChatExecutionControlOperations(
      repository,
      host(),
      { assertAvailable },
    );
    const command = { key: 'command-1', entryId: 'entry-1' };

    const created = await operations.create('chat-1', 'queued work', command);
    assertAvailable.mockImplementation(async () => {
      throw new ProjectUnavailableError('/workspace/missing', 'not-found');
    });
    const duplicate = await operations.create('chat-1', 'queued work', command);

    expect(created.duplicate).toBe(false);
    expect(duplicate).toMatchObject({ entryId: created.entryId, duplicate: true });
    expect(assertAvailable).toHaveBeenCalledTimes(1);
    expect((await repository.load('chat-1')).entries).toHaveLength(1);
  });
});
