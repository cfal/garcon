import { describe, expect, it, mock } from 'bun:test';
import { ChatExecutionControlOperations } from '../chat-execution-control-operations.ts';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.ts';
import { DomainError, ProjectUnavailableError } from '../../../common/domain-error.ts';

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
    const created = await operations.create('chat-1', { content: 'queued guidance', images: [] });
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

    await expect(operations.create('chat-1', {
      content: 'queued work',
      images: [],
      command: { key: 'command-1', entryId: 'entry-1' },
    })).rejects.toBe(unavailable);

    expect(await repository.load('chat-1')).toMatchObject({
      version: 0,
      entries: [],
      appliedCommands: [],
    });
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

    const created = await operations.create('chat-1', { content: 'queued work', images: [], command });
    assertAvailable.mockImplementation(async () => {
      throw new ProjectUnavailableError('/workspace/missing', 'not-found');
    });
    const duplicate = await operations.create('chat-1', { content: 'queued work', images: [], command });

    expect(created.duplicate).toBe(false);
    expect(duplicate).toMatchObject({ entryId: created.entryId, duplicate: true });
    expect(assertAvailable).toHaveBeenCalledTimes(1);
    expect((await repository.load('chat-1')).entries).toHaveLength(1);
  });

  it('queues a steer ahead of queued turns and publishes it once', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const publish = mock(() => undefined);
    const operations = new ChatExecutionControlOperations(
      repository,
      { ...host(), publish },
      { assertAvailable: mock(async () => undefined) },
    );
    const turn = await operations.create('chat-1', { content: 'queued turn', images: [] });
    const command = { key: 'steer-command-1', entryId: 'steer-entry-1' };
    const submission = { clientMessageId: 'message-steer-1', transcriptViewId: 'view-1' };

    const steer = await operations.createSteer('chat-1', 'guidance', command, submission);
    const duplicate = await operations.createSteer('chat-1', 'guidance', command, submission);

    expect(steer).toMatchObject({ entryId: 'steer-entry-1', duplicate: false });
    expect(duplicate).toMatchObject({ entryId: 'steer-entry-1', duplicate: true });
    expect(steer.control.entries.map(({ id, kind }) => [id, kind])).toEqual([
      ['steer-entry-1', 'steer'],
      [turn.entryId, 'turn'],
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('turns the queue head into a steer', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const operations = new ChatExecutionControlOperations(
      repository,
      host(),
      { assertAvailable: mock(async () => undefined) },
    );
    const created = await operations.create('chat-1', { content: 'queued guidance', images: [] });

    const marked = await operations.markSteer('chat-1', {
      entryId: created.entryId,
      expectedRevision: 1,
      expectedReorderRevision: 0,
    });

    expect(marked.entries).toEqual([
      expect.objectContaining({ id: created.entryId, kind: 'steer', status: 'queued', revision: 1 }),
    ]);
  });

  it('checks attachment support only before committing a new queue entry', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const assertSupported = mock(() => undefined);
    const operations = new ChatExecutionControlOperations(
      repository,
      host(),
      { assertAvailable: mock(async () => undefined) },
      { assertSupported },
    );
    const images = [{ data: 'data:image/png;base64,AAAA', name: 'screen.png', mimeType: 'image/png' }];
    const command = { key: 'command-1', entryId: 'entry-1' };

    await operations.create('chat-1', { content: 'text only', images: [] });
    expect(assertSupported).not.toHaveBeenCalled();

    const created = await operations.create('chat-1', { content: '', images, command });
    assertSupported.mockImplementation(() => {
      throw new DomainError('UNSUPPORTED_AGENT', 'Attachments unsupported for agent: claude', 422);
    });
    const duplicate = await operations.create('chat-1', { content: '', images, command });
    expect(duplicate).toMatchObject({ entryId: created.entryId, duplicate: true });
    expect(assertSupported).toHaveBeenCalledTimes(1);

    await expect(operations.create('chat-1', {
      content: 'rejected',
      images,
      command: { key: 'command-2', entryId: 'entry-2' },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_AGENT' });
    expect((await repository.load('chat-1')).entries.map((entry) => entry.content))
      .toEqual(['text only', '']);
  });
});
