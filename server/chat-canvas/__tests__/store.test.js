import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, symlink, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasStore } from '../store.ts';
import { CANVAS_MAX_COUNT } from '../../../common/chat-canvas.ts';

const directories = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const content = (title = 'Work') => ({ title, nodes: [], connections: [] });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-store-')); directories.push(dir);
  return { dir, store: new CanvasStore(dir) };
}

function failDirectorySync(directory) {
  const failure = Object.assign(new Error('Directory sync failed'), { code: 'EIO' });
  const open = fs.open;
  let failing = true;
  let attempts = 0;
  const mock = spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === directory) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        attempts++;
        if (failing) throw failure;
        await sync();
      };
    }
    return handle;
  });
  return {
    failure,
    get attempts() { return attempts; },
    recover() { failing = false; },
    restore() { mock.mockRestore(); },
  };
}

describe('CanvasStore', () => {
  it.each(['create', 'update'])('confirms directory durability before acknowledging an identical %s retry', async (operation) => {
    const { dir, store } = await fixture();
    if (operation === 'update') await store.create('board', content());
    const fault = failDirectorySync(join(dir, 'chat-canvases'));
    const invoke = (target) => operation === 'create'
      ? target.create('board', content('Candidate'))
      : target.update('board', 1, content('Candidate'));
    try {
      await expect(invoke(store)).rejects.toMatchObject({ renamed: true });
      const candidate = await store.get('board');
      expect(candidate.revision).toBe(operation === 'create' ? 1 : 2);
      await expect(invoke(store)).rejects.toBe(fault.failure);
      const reopened = new CanvasStore(dir);
      await expect(invoke(reopened)).rejects.toBe(fault.failure);
      fault.recover();
      expect(await invoke(reopened)).toEqual(candidate);
      expect(fault.attempts).toBe(4);
    } finally { fault.restore(); }
  });

  it('confirms a prior unlink is durable before returning an accepted deletion 404', async () => {
    const { dir, store } = await fixture();
    await store.create('board', content());
    const fault = failDirectorySync(join(dir, 'chat-canvases'));
    try {
      await expect(store.remove('board', 1)).rejects.toBe(fault.failure);
      await expect(store.get('board')).rejects.toMatchObject({ status: 404 });
      await expect(store.remove('board', 1)).rejects.toBe(fault.failure);
      const reopened = new CanvasStore(dir);
      await expect(reopened.remove('board', 1)).rejects.toBe(fault.failure);
      fault.recover();
      await expect(reopened.remove('board', 1)).rejects.toMatchObject({ status: 404 });
      expect(fault.attempts).toBe(4);
    } finally { fault.restore(); }
  });

  it('returns deletion 404 before any canvas directory exists', async () => {
    const { store } = await fixture();
    await expect(store.remove('absent', 1)).rejects.toMatchObject({ status: 404 });
  });

  it('isolates directories and symlink loops named as canvas files', async () => {
    const { dir, store } = await fixture();
    await store.create('healthy', content());
    await mkdir(join(dir, 'chat-canvases/directory.json'));
    await symlink('loop.json', join(dir, 'chat-canvases/loop.json'));
    const catalog = await store.list();
    expect(catalog.unavailableIds).toEqual(['directory', 'loop']);
    expect(catalog.canvases.map((entry) => entry.id)).toEqual(['healthy']);
    for (const id of catalog.unavailableIds) {
      await expect(store.get(id)).rejects.toMatchObject({ code: 'CANVAS_CORRUPT' });
      await expect(store.create(id, content())).rejects.toMatchObject({ code: 'CANVAS_CORRUPT' });
    }
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'EMFILE'])('classifies %s without masking systemic failures', async (code) => {
    const { dir, store } = await fixture();
    await store.create('healthy', content());
    await store.create('unreadable', content());
    const read = fs.readFile;
    const failure = Object.assign(new Error(code), { code });
    const mock = spyOn(fs, 'readFile').mockImplementation((file, ...args) => {
      if (file === join(dir, 'chat-canvases/unreadable.json')) return Promise.reject(failure);
      return read(file, ...args);
    });
    try {
      if (code === 'EACCES' || code === 'EPERM') {
        expect((await store.list()).unavailableIds).toEqual(['unreadable']);
        await expect(store.get('unreadable')).rejects.toMatchObject({ code: 'CANVAS_CORRUPT' });
      } else await expect(store.list()).rejects.toBe(failure);
    } finally { mock.mockRestore(); }
  });

  it('reports unreadable boards without blocking healthy boards or overwriting damaged data', async () => {
    const { dir, store } = await fixture();
    await store.create('healthy', content());
    const damagedPath = join(dir, 'chat-canvases/damaged.json');
    await writeFile(damagedPath, '{broken');
    await writeFile(join(dir, 'chat-canvases/backup copy.json'), '{unrelated');
    expect((await store.list()).unavailableIds).toEqual(['damaged']);
    expect((await store.list()).canvases.map((canvas) => canvas.id)).toEqual(['healthy']);
    await store.create('new', content('New'));
    await expect(store.create('damaged', content())).rejects.toMatchObject({ code: 'CANVAS_CORRUPT' });
    expect(await readFile(damagedPath, 'utf8')).toBe('{broken');
  });

  it('counts unreadable board identities toward the catalog limit', async () => {
    const { dir, store } = await fixture();
    await store.create('healthy', content());
    await Promise.all(Array.from({ length: CANVAS_MAX_COUNT - 1 }, (_, index) =>
      writeFile(join(dir, `chat-canvases/damaged-${index}.json`), '{broken')));
    await expect(store.create('overflow', content())).rejects.toMatchObject({ code: 'CANVAS_LIMIT' });
  });

  it('persists each board separately and survives new store instances', async () => {
    const { dir, store } = await fixture();
    expect(await store.list()).toEqual({ canvases: [], unavailableIds: [] });
    const created = await store.create('a', content());
    const other = await store.create('b', content('Other'));
    const updated = await store.update('a', 1, content('Renamed'));
    expect(updated.revision).toBe(2);
    expect(await new CanvasStore(dir).get('a')).toEqual(updated);
    expect(await store.get('b')).toEqual(other);
    expect(JSON.parse(await readFile(join(dir, 'chat-canvases/a.json'), 'utf8'))).toEqual(updated);
    await expect(store.remove('a', created.revision)).rejects.toMatchObject({ code: 'CANVAS_CONFLICT' });
    await store.remove('a', 2);
    expect((await store.list()).canvases.map((c) => c.id)).toEqual(['b']);
  });

  it('admits exactly one concurrent edit and preserves lost-response retries', async () => {
    const { store } = await fixture();
    const original = await store.create('a', content());
    expect(await store.create('a', content())).toEqual(original);
    const results = await Promise.allSettled([
      store.update('a', 1, content('First')),
      store.update('a', 1, content('Second')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason.code).toBe('CANVAS_CONFLICT');
    const current = await store.get('a');
    expect(await store.update('a', 1, current.content)).toEqual(current);
  });

  it('refuses path traversal and never overwrites malformed or future documents', async () => {
    const { dir, store } = await fixture();
    await expect(store.get('../outside')).rejects.toMatchObject({ status: 400 });
    await store.create('a', content());
    const file = join(dir, 'chat-canvases/a.json');
    for (const raw of ['{broken', JSON.stringify({ version: 99 })]) {
      await writeFile(file, raw);
      await expect(store.update('a', 1, content('Replacement'))).rejects.toMatchObject({ code: 'CANVAS_CORRUPT' });
      expect(await readFile(file, 'utf8')).toBe(raw);
    }
  });
  it('keeps client IDs separate from the catalog lock', async () => {
    const { store } = await fixture();
    expect((await store.create('catalog', content())).id).toBe('catalog');
    expect((await store.update('catalog', 1, content('Updated'))).revision).toBe(2);
    await store.remove('catalog', 2);
    expect((await store.list()).canvases).toEqual([]);
  });

});
