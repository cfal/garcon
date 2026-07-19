import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  JsonChatExecutionControlRepository,
} from '../chat-execution-control-repository.ts';
import {
  cloneStoredChatExecutionControl,
  emptyStoredChatExecutionControl,
} from '../../chat-execution-control-state.ts';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'control-repository-'));
  temporaryDirectories.push(directory);
  return directory;
}

class InMemoryControlRepository {
  controls = new Map();

  async load(chatId) {
    return cloneStoredChatExecutionControl(this.controls.get(chatId) ?? emptyStoredChatExecutionControl());
  }

  async loadFresh(chatId) {
    return { control: await this.load(chatId), needsCanonicalization: false };
  }

  async save(chatId, control) {
    this.controls.set(chatId, cloneStoredChatExecutionControl(control));
    return this.load(chatId);
  }

  async delete(chatId) {
    this.controls.delete(chatId);
  }

  async listStoredChatIds() {
    return [...this.controls.keys()];
  }
}

function repositoryContract(name, createRepository) {
  describe(`${name} repository contract`, () => {
    it('loads missing state, isolates returned values, enumerates, and deletes', async () => {
      const repository = await createRepository();
      const missing = await repository.load('chat-1');
      expect(missing).toEqual(emptyStoredChatExecutionControl());

      const stored = emptyStoredChatExecutionControl();
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
      expect(await repository.listStoredChatIds()).toEqual(['chat-1']);
      await repository.delete('chat-1');
      expect(await repository.load('chat-1')).toEqual(emptyStoredChatExecutionControl());
    });
  });
}

repositoryContract('in-memory', async () => new InMemoryControlRepository());
repositoryContract('JSON', async () => new JsonChatExecutionControlRepository(await temporaryDirectory()));

describe('JsonChatExecutionControlRepository', () => {
  it('strictly rejects malformed durable state', async () => {
    const workspace = await temporaryDirectory();
    const queues = path.join(workspace, 'queues');
    await fs.mkdir(queues);
    await fs.writeFile(path.join(queues, 'chat-1.queue.json'), JSON.stringify({
      entries: [{ id: 'broken' }],
    }));
    const repository = new JsonChatExecutionControlRepository(workspace);

    await expect(repository.loadFresh('chat-1')).rejects.toThrow(
      'Queue state entries contains an invalid record',
    );
  });

  it('reports legacy state that requires startup canonicalization', async () => {
    const workspace = await temporaryDirectory();
    const queues = path.join(workspace, 'queues');
    await fs.mkdir(queues);
    await fs.writeFile(path.join(queues, 'chat-1.queue.json'), JSON.stringify({
      entries: [{
        id: 'entry-1',
        content: 'queued',
        status: 'queued',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
      paused: true,
    }));
    const repository = new JsonChatExecutionControlRepository(workspace);

    const snapshot = await repository.loadFresh('chat-1');
    expect(snapshot.needsCanonicalization).toBe(true);
    expect(snapshot.control.pause).toMatchObject({ kind: 'unknown' });
    expect(snapshot.control.entries[0]).toMatchObject({ revision: 1 });
  });

  it('keeps the last committed cache when an atomic save fails', async () => {
    const workspace = await temporaryDirectory();
    const repository = new JsonChatExecutionControlRepository(workspace);
    const initial = emptyStoredChatExecutionControl();
    initial.version = 1;
    initial.updatedAt = '2026-07-19T00:00:00.000Z';
    await repository.save('chat-1', initial);

    await fs.rename(path.join(workspace, 'queues'), path.join(workspace, 'queues-backup'));
    await fs.writeFile(path.join(workspace, 'queues'), 'not a directory');
    const replacement = { ...initial, version: 2, updatedAt: '2026-07-19T00:00:01.000Z' };
    await expect(repository.save('chat-1', replacement)).rejects.toThrow();

    expect((await repository.load('chat-1')).version).toBe(1);
  });

  it('preserves every applied receipt during storage normalization', async () => {
    const workspace = await temporaryDirectory();
    const repository = new JsonChatExecutionControlRepository(workspace);
    const control = emptyStoredChatExecutionControl();
    control.appliedCommands = Array.from({ length: 1_005 }, (_, index) => ({
      key: `key-${index}`,
      operation: 'create',
      entryId: `entry-${index}`,
      appliedAt: '2026-07-19T00:00:00.000Z',
    }));

    await repository.save('chat-1', control);
    expect((await repository.loadFresh('chat-1')).control.appliedCommands).toHaveLength(1_005);
  });
});
