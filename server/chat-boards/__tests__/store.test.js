import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AtomicJsonWriteError } from '../../lib/json-file-store.ts';
import { ChatBoardStore } from '../store.ts';

const BOARD_A = '11111111-1111-4111-8111-111111111111';
const BOARD_B = '22222222-2222-4222-8222-222222222222';
const COLUMN_A = '33333333-3333-4333-8333-333333333333';
const directories = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-boards-'));
  directories.push(directory);
  return directory;
}

function board(id = BOARD_A, name = 'Delivery') {
  return {
    id,
    name,
    columns: [{ id: COLUMN_A, name: 'Ready', match: 'all', tags: ['ready'] }],
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('ChatBoardStore', () => {
  it('starts empty and persists private ordered catalog mutations', async () => {
    const directory = await temporaryDirectory();
    const store = new ChatBoardStore(directory);
    await store.init();
    expect(store.snapshot()).toEqual({ revision: 0, boards: [] });

    const first = await store.createWithGeneratedId('Delivery', 0, () => BOARD_A);
    const second = await store.createWithGeneratedId('Support', 1, () => BOARD_B);
    expect(first).toMatchObject({ result: BOARD_A, catalog: { revision: 1 } });
    expect(second).toMatchObject({ result: BOARD_B, catalog: { revision: 2 } });
    await store.update(board(), 2);
    await store.reorder([BOARD_B, BOARD_A], 3);

    const filePath = path.join(directory, 'chat-boards.json');
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    const reopened = new ChatBoardStore(directory);
    await reopened.init();
    expect(reopened.snapshot().boards.map((entry) => entry.id)).toEqual([BOARD_B, BOARD_A]);
    expect(reopened.snapshot().revision).toBe(4);
  });

  it('checks revision before state validation and requires an exact reorder permutation', async () => {
    const store = new ChatBoardStore(await temporaryDirectory());
    await store.init();
    await store.createWithGeneratedId('Delivery', 0, () => BOARD_A);
    const before = store.snapshot();

    await expect(store.remove(BOARD_B, 0)).rejects.toMatchObject({
      code: 'CHAT_BOARD_REVISION_CONFLICT',
      catalog: before,
    });
    await expect(store.reorder([], 1)).rejects.toMatchObject({
      code: 'CHAT_BOARD_VALIDATION_FAILED',
    });
    expect(store.snapshot()).toEqual(before);
  });

  it('serializes competing same-revision mutations', async () => {
    const store = new ChatBoardStore(await temporaryDirectory());
    await store.init();
    const results = await Promise.allSettled([
      store.createWithGeneratedId('Delivery', 0, () => BOARD_A),
      store.createWithGeneratedId('Support', 0, () => BOARD_B),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.snapshot()).toMatchObject({ revision: 1 });
  });

  it('preserves state after a pre-rename failure and fences a post-rename outcome', async () => {
    const directory = await temporaryDirectory();
    let failure = new AtomicJsonWriteError('before rename', false);
    const store = new ChatBoardStore(directory, {
      writeFile: async () => {
        if (failure) {
          const current = failure;
          failure = null;
          throw current;
        }
      },
    });
    await store.init();
    await expect(store.createWithGeneratedId('Delivery', 0, () => BOARD_A)).rejects.toThrow();
    expect(store.snapshot()).toEqual({ revision: 0, boards: [] });
    await expect(store.createWithGeneratedId('Delivery', 0, () => BOARD_A)).resolves.toMatchObject({
      catalog: { revision: 1 },
    });

    const fenced = new ChatBoardStore(directory, {
      writeFile: async () => {
        throw new AtomicJsonWriteError('after rename', true);
      },
    });
    await fenced.init();
    await expect(fenced.createWithGeneratedId('Support', 0, () => BOARD_B)).rejects.toThrow();
    expect(fenced.snapshot()).toMatchObject({ revision: 1, boards: [{ id: BOARD_B }] });
    await expect(fenced.createWithGeneratedId('Another', 1, () => BOARD_A)).rejects.toMatchObject({
      code: 'CHAT_BOARD_CATALOG_SAVE_UNKNOWN',
    });
  });

  it('reports malformed persisted data with its path and leaves it untouched', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'chat-boards.json');
    await fs.writeFile(filePath, '{"version":1,"revision":0,"boards":[', 'utf8');
    await expect(new ChatBoardStore(directory).init()).rejects.toThrow(filePath);
    expect(await fs.readFile(filePath, 'utf8')).toBe('{"version":1,"revision":0,"boards":[');
  });
});
