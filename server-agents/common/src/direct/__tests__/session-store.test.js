import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirectSessionStore } from '../session-store.ts';

const createdDirs = [];

async function createStore(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-direct-store-'));
  createdDirs.push(root);
  return {
    root,
    path: path.join(root, 'session.jsonl'),
    store: new DirectSessionStore({
      getSessionDir: () => root,
      getSessionFilePath: () => path.join(root, 'session.jsonl'),
      ...options,
    }),
  };
}

const identity = {
  clientRequestId: 'request-a',
  clientMessageId: 'message-a',
  turnId: 'turn-a',
};

function instrumentedFileSystem(operations) {
  return {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          const value = target[property];
          if (typeof value !== 'function') return value;
          return async (...methodArgs) => {
            if (
              property === 'truncate'
              || property === 'writeFile'
              || property === 'sync'
              || property === 'close'
            ) operations.push(String(property));
            return value.apply(target, methodArgs);
          };
        },
      });
    },
  };
}

describe('DirectSessionStore', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('requires the complete delivery identity tuple to match', async () => {
    const { store } = await createStore();
    await store.append('session', 'user', 'hello', identity);

    await expect(store.prepareUserTurn('session', 'hello', {
      ...identity,
      clientRequestId: 'request-b',
      turnId: 'turn-b',
    })).rejects.toThrow('conflicts with the persisted identity tuple');
    await expect(store.prepareUserTurn('session', 'hello', {
      clientMessageId: identity.clientMessageId,
    })).rejects.toThrow('conflicts with the persisted identity tuple');
    expect(await store.read('session')).toHaveLength(1);
  });

  it('syncs an appended record before syncing a newly created directory entry', async () => {
    const operations = [];
    const { store } = await createStore({
      fileSystem: instrumentedFileSystem(operations),
      syncDirectory: async () => {
        operations.push('directory-sync');
      },
    });

    await store.append('session', 'user', 'durable', identity);

    expect(operations).toEqual(['writeFile', 'sync', 'close', 'directory-sync']);
  });

  it('recognizes completion only from an assistant with the same identity tuple', async () => {
    const { store } = await createStore();
    await store.append('session', 'user', 'hello', identity);
    await store.append('session', 'assistant', 'first response', {
      ...identity,
      turnId: 'other-turn',
    });
    expect(await store.prepareUserTurn('session', 'hello', identity)).toBe('already-persisted');

    await store.append('session', 'assistant', 'final response', identity);
    expect(await store.prepareUserTurn('session', 'hello', identity)).toBe('turn-complete');
  });

  it('repairs an incomplete trailing record before appending', async () => {
    const { store, path: sessionPath } = await createStore();
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify({ role: 'user', content: 'complete' })}\n{"role":"user"`,
    );

    await store.append('session', 'user', 'after crash', identity);

    expect(await store.read('session')).toMatchObject([
      { role: 'user', content: 'complete' },
      { role: 'user', content: 'after crash', ...identity },
    ]);
    const lines = (await fs.readFile(sessionPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).content)).toEqual(['complete', 'after crash']);
  });

  it('syncs a repaired truncation before appending the next durable record', async () => {
    const { root, path: sessionPath } = await createStore();
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify({ role: 'user', content: 'complete' })}\n{"role":"user"`,
    );
    const operations = [];
    const store = new DirectSessionStore({
      getSessionDir: () => root,
      getSessionFilePath: () => sessionPath,
      fileSystem: instrumentedFileSystem(operations),
    });

    await store.append('session', 'user', 'after repair', identity);

    expect(operations).toEqual([
      'truncate',
      'sync',
      'close',
      'writeFile',
      'sync',
      'close',
    ]);
  });

  it('preserves a valid final record without a newline before appending', async () => {
    const { store, path: sessionPath } = await createStore();
    await fs.writeFile(sessionPath, JSON.stringify({ role: 'user', content: 'complete' }));

    await store.append('session', 'assistant', 'next');

    expect(await store.read('session')).toMatchObject([
      { role: 'user', content: 'complete' },
      { role: 'assistant', content: 'next' },
    ]);
  });

  it('fails loudly on malformed complete records', async () => {
    const { store, path: sessionPath } = await createStore();
    const malformed = '{"role":"user"\n';
    await fs.writeFile(sessionPath, malformed);

    await expect(store.read('session')).rejects.toThrow('malformed record at line 1');
    await expect(store.append('session', 'user', 'must not append')).rejects.toThrow(
      'malformed record at line 1',
    );
    expect(await fs.readFile(sessionPath, 'utf8')).toBe(malformed);
  });

  it('revalidates a same-length file after its filesystem revision changes', async () => {
    const { store, path: sessionPath } = await createStore();
    await store.append('session', 'user', 'complete', identity);
    const original = await fs.readFile(sessionPath, 'utf8');
    const corrupted = original.replace('"role":"user"', '"role":"nope"');
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(original));
    await fs.writeFile(sessionPath, corrupted);
    const changedAt = new Date(Date.now() + 5_000);
    await fs.utimes(sessionPath, changedAt, changedAt);

    await expect(store.append('session', 'assistant', 'must not append')).rejects.toThrow(
      'malformed record at line 1',
    );
    expect(await fs.readFile(sessionPath, 'utf8')).toBe(corrupted);
  });
});
