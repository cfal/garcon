import { describe, expect, it } from 'bun:test';
import {
  InMemoryChatExecutionControlRepository,
} from '../chat-execution-control-repository.ts';
import { emptyStoredChatExecutionControl } from '../control-state.ts';

describe('InMemoryChatExecutionControlRepository', () => {
  it('loads missing state, isolates returned values, and deletes', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const missing = await repository.load('chat-1');
    expect(missing).toEqual(emptyStoredChatExecutionControl('server-instance-test'));

    const stored = emptyStoredChatExecutionControl('server-instance-test');
    stored.version = 1;
    stored.updatedAt = '2026-07-19T00:00:00.000Z';
    stored.entries.push({
      id: 'entry-1',
      content: 'queued',
      revision: 1,
      status: 'queued',
      createdAt: stored.updatedAt,
      updatedAt: stored.updatedAt,
    });
    const saved = await repository.save('chat-1', stored);
    saved.entries[0].content = 'caller mutation';
    stored.entries[0].content = 'input mutation';

    expect((await repository.load('chat-1')).entries[0].content).toBe('queued');
    await repository.delete('chat-1');
    expect(await repository.load('chat-1')).toEqual(emptyStoredChatExecutionControl('server-instance-test'));
  });

  it('preserves every applied receipt while cloning storage', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
    const control = emptyStoredChatExecutionControl('server-instance-test');
    control.appliedCommands = Array.from({ length: 1_005 }, (_, index) => ({
      key: `key-${index}`,
      operation: 'create',
      entryId: `entry-${index}`,
      appliedAt: '2026-07-19T00:00:00.000Z',
    }));

    await repository.save('chat-1', control);
    expect((await repository.load('chat-1')).appliedCommands).toHaveLength(1_005);
  });

  it('uses one identity until the repository is replaced', async () => {
    const repository = new InMemoryChatExecutionControlRepository('server-a');
    expect((await repository.load('chat-1')).serverInstanceId).toBe('server-a');
    expect((await repository.load('chat-2')).serverInstanceId).toBe('server-a');

    const replacement = new InMemoryChatExecutionControlRepository('server-b');
    expect(await replacement.load('chat-1')).toEqual(
      emptyStoredChatExecutionControl('server-b'),
    );
  });

  it('rejects controls owned by another repository instance', () => {
    const repository = new InMemoryChatExecutionControlRepository('server-a');
    expect(() => (
      repository.save('chat-1', emptyStoredChatExecutionControl('server-b'))
    )).toThrow('another server instance');
  });
});
