import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('CanvasStore', () => {
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
