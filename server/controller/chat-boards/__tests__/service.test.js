import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatBoardService } from '../service.ts';
import { ChatBoardStore } from '../store.ts';

const BOARD_A = '11111111-1111-4111-8111-111111111111';
const BOARD_B = '22222222-2222-4222-8222-222222222222';
const directories = [];

async function createService(ids = [BOARD_A, BOARD_B]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-board-service-'));
  directories.push(directory);
  const store = new ChatBoardStore(directory);
  await store.init();
  return new ChatBoardService({ store, newId: () => ids.shift() });
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('ChatBoardService', () => {
  it('emits the exact committed revision and reason once', async () => {
    const service = await createService();
    const events = [];
    service.on('invalidated', (revision, reason) => events.push({ revision, reason }));

    const created = await service.create({ expectedRevision: 0, name: 'Delivery' });
    const second = await service.create({ expectedRevision: 1, name: 'Support' });
    await service.reorder({ expectedRevision: 2, orderedBoardIds: [second.boardId, created.boardId] });

    expect(events).toEqual([
      { revision: 1, reason: 'created' },
      { revision: 2, reason: 'created' },
      { revision: 3, reason: 'reordered' },
    ]);
  });

  it('does not turn a committed mutation into a failure when a listener throws', async () => {
    const service = await createService();
    service.on('invalidated', () => {
      throw new Error('listener failed');
    });

    await expect(service.create({ expectedRevision: 0, name: 'Delivery' })).resolves.toMatchObject({
      catalog: { revision: 1 },
    });
    expect(service.snapshot()).toMatchObject({ revision: 1 });
  });
});
