import { afterEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatBoardService } from '../../chat-boards/service.ts';
import { ChatBoardStore } from '../../chat-boards/store.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { ChatTagMutationService } from '../chat-tag-mutation-service.ts';

const CHAT_ID = '1788781395788500';
const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const directories = [];

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function registryDouble(initialTags = ['project', 'ready']) {
  let entry = { tags: [...initialTags] };
  let durability = 'confirmed';
  const registry = {
    getChat: mock(() => entry && { ...entry, tags: [...entry.tags] }),
    chatMutationDurability: mock(() => entry ? durability : 'unavailable'),
    updateChatPhased: mock(async (chatId, patch) => {
      if (!entry || chatId !== CHAT_ID) return null;
      entry = { ...entry, ...patch, tags: [...patch.tags] };
      return { entry: { id: chatId, ...entry }, durability: 'durable' };
    }),
    reconcileUnknownDurability: mock(async () => {
      durability = 'confirmed';
      return entry ? 'confirmed' : 'unavailable';
    }),
  };
  return {
    registry,
    tags: () => entry?.tags,
    setDurability: (value) => { durability = value; },
  };
}

function board(name = 'Delivery') {
  return {
    id: BOARD_ID,
    name,
    columns: [
      { id: SOURCE_ID, name: 'Ready', match: 'all', tags: ['ready'] },
      { id: TARGET_ID, name: 'Review', match: 'all', tags: ['review'] },
    ],
  };
}

function serviceWith(registry, boards = {
  withCatalogRevision: async (revision, work) => {
    if (revision !== 4) throw new Error('stale revision');
    return work({ revision: 4, boards: [board()] });
  },
}, archiveState = { confirmArchiveState: async () => false }) {
  return new ChatTagMutationService({
    registry,
    boards,
    archiveState,
    chatMutationLock: new KeyedPromiseLock(),
  });
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('ChatTagMutationService', () => {
  it('compares replacement baselines and applies serialized deltas without losing tags', async () => {
    const current = registryDouble();
    const service = serviceWith(current.registry);

    await expect(service.replace({
      chatId: CHAT_ID,
      expectedTags: ['stale'],
      tags: ['review'],
    })).rejects.toMatchObject({
      code: 'CHAT_TAG_REVISION_CONFLICT',
      currentTags: ['project', 'ready'],
    });

    await Promise.all([
      service.applyDelta({ chatId: CHAT_ID, addTags: ['urgent'] }),
      service.applyDelta({ chatId: CHAT_ID, removeTags: ['ready'], addTags: ['review'] }),
    ]);
    expect(current.tags()).toEqual(['project', 'review', 'urgent']);
  });

  it('applies ALL targets authoritatively and removes every present ANY source tag', async () => {
    const current = registryDouble(['project', 'ready', 'triage']);
    const catalog = {
      revision: 4,
      boards: [{
        ...board(),
        columns: [
          { id: SOURCE_ID, name: 'Queue', match: 'any', tags: ['ready', 'triage'] },
          { id: TARGET_ID, name: 'Review', match: 'all', tags: ['review', 'shared'] },
        ],
      }],
    };
    const service = serviceWith(current.registry, {
      withCatalogRevision: async (_revision, work) => work(catalog),
    });

    const result = await service.transition({
      chatId: CHAT_ID,
      boardId: BOARD_ID,
      sourceColumnId: SOURCE_ID,
      targetColumnId: TARGET_ID,
      expectedCatalogRevision: 4,
      expectedTags: ['project', 'ready', 'triage'],
      selectedTargetTags: ['ignored'],
    });
    expect(result).toMatchObject({
      tags: ['project', 'review', 'shared'],
      addedTags: ['review', 'shared'],
      removedTags: ['ready', 'triage'],
    });
  });

  it('validates ANY target selection and rejects archived chats without writing', async () => {
    const current = registryDouble();
    const anyBoard = {
      revision: 4,
      boards: [{
        ...board(),
        columns: [
          board().columns[0],
          { id: TARGET_ID, name: 'Review', match: 'any', tags: ['review', 'testing'] },
        ],
      }],
    };
    const boards = { withCatalogRevision: async (_revision, work) => work(anyBoard) };
    const service = serviceWith(current.registry, boards);
    const input = {
      chatId: CHAT_ID,
      boardId: BOARD_ID,
      sourceColumnId: SOURCE_ID,
      targetColumnId: TARGET_ID,
      expectedCatalogRevision: 4,
      expectedTags: ['project', 'ready'],
    };

    await expect(service.transition(input)).rejects.toMatchObject({
      code: 'CHAT_BOARD_TRANSITION_INVALID',
    });
    await expect(serviceWith(current.registry, boards, {
      confirmArchiveState: async () => true,
    }).transition({
      ...input,
      selectedTargetTags: ['review'],
    })).rejects.toMatchObject({ code: 'CHAT_BOARD_TRANSITION_CHAT_ARCHIVED' });
    expect(current.registry.updateChatPhased).not.toHaveBeenCalled();
  });

  it('does not write tags when archive-state confirmation fails', async () => {
    const current = registryDouble();
    const confirmationError = new Error('archive durability remains unknown');
    const service = serviceWith(current.registry, undefined, {
      confirmArchiveState: async () => { throw confirmationError; },
    });

    await expect(service.transition({
      chatId: CHAT_ID,
      boardId: BOARD_ID,
      sourceColumnId: SOURCE_ID,
      targetColumnId: TARGET_ID,
      expectedCatalogRevision: 4,
      expectedTags: ['project', 'ready'],
    })).rejects.toBe(confirmationError);
    expect(current.registry.updateChatPhased).not.toHaveBeenCalled();
  });

  it('honors the durability fence before returning any no-op and recovers explicitly', async () => {
    const current = registryDouble();
    current.setDurability('unknown');
    const service = serviceWith(current.registry);

    await expect(service.applyDelta({ chatId: CHAT_ID, addTags: ['ready'] })).rejects.toMatchObject({
      code: 'CHAT_TAG_SAVE_UNKNOWN',
    });
    await expect(service.replace({
      chatId: CHAT_ID,
      expectedTags: ['project', 'ready'],
      tags: ['project', 'ready'],
    })).rejects.toMatchObject({ code: 'CHAT_TAG_SAVE_UNKNOWN' });
    expect(current.registry.updateChatPhased).not.toHaveBeenCalled();

    await expect(service.recover(CHAT_ID)).resolves.toEqual({
      success: true,
      chatId: CHAT_ID,
      tags: ['project', 'ready'],
    });
  });

  it('holds the catalog revision lease through the phased tag commit', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-board-lock-'));
    directories.push(directory);
    const store = new ChatBoardStore(directory);
    await store.init();
    const boards = new ChatBoardService({ store, newId: () => BOARD_ID });
    await boards.create({ expectedRevision: 0, name: 'Delivery' });
    await boards.update({ expectedRevision: 1, board: board() });

    const current = registryDouble();
    const enteredWrite = deferred();
    const releaseWrite = deferred();
    current.registry.updateChatPhased.mockImplementation(async (chatId, patch) => {
      enteredWrite.resolve();
      await releaseWrite.promise;
      return {
        entry: { id: chatId, tags: [...patch.tags] },
        durability: 'durable',
      };
    });
    const service = serviceWith(current.registry, boards);
    const transition = service.transition({
      chatId: CHAT_ID,
      boardId: BOARD_ID,
      sourceColumnId: SOURCE_ID,
      targetColumnId: TARGET_ID,
      expectedCatalogRevision: 2,
      expectedTags: ['project', 'ready'],
    });
    await enteredWrite.promise;

    let catalogCommitted = false;
    const catalogEdit = boards.update({
      expectedRevision: 2,
      board: board('Renamed'),
    }).then(() => { catalogCommitted = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(catalogCommitted).toBe(false);

    releaseWrite.resolve();
    await transition;
    await catalogEdit;
    expect(boards.snapshot()).toMatchObject({ revision: 3, boards: [{ name: 'Renamed' }] });
  });
});
