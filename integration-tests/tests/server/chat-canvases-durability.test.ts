import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatCanvas } from '../../../common/chat-canvas.js';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const endpoint = '/api/v1/chat-canvases';
const content = { title: 'Synthetic board', nodes: [], connections: [] };
for (const method of ['POST', 'PUT', 'DELETE'] as const) {
  test(`${method} retries keep reporting unconfirmed directory durability`, async () => {
    await withIntegrationFixture(`canvas-durability-${method.toLowerCase()}`, async (fixture) => {
      const file = join(fixture.dirs.workspace, 'chat-canvases/board.json');
      const failureFile = join(fixture.dirs.root, 'fail-canvas-sync');
      if (method !== 'POST') await fixture.client.post<ChatCanvas>(endpoint, { id: 'board', content });
      const updated = { ...content, title: 'Updated board' };
      const request = () => {
        if (method === 'POST') return fixture.client.post<ChatCanvas>(endpoint, { id: 'board', content });
        if (method === 'PUT') return fixture.client.put<ChatCanvas>(endpoint, { id: 'board', expectedRevision: 1, content: updated });
        return fixture.client.delete(endpoint, { id: 'board', expectedRevision: 1 });
      };
      await writeFile(failureFile, 'fail');
      await expect(request()).rejects.toMatchObject({ status: 500 });
      if (method === 'DELETE') await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(JSON.parse(await readFile(file, 'utf8')).revision).toBe(method === 'PUT' ? 2 : 1);
      await expect(request()).rejects.toMatchObject({ status: 500 });
      await fixture.restartGarcon();
      await expect(request()).rejects.toMatchObject({ status: 500 });
      await rm(failureFile);
      if (method === 'DELETE') await expect(request()).rejects.toMatchObject({ status: 404 });
      else expect(await request()).toMatchObject({ revision: method === 'PUT' ? 2 : 1, content: method === 'PUT' ? updated : content });
    }, {
      resolveServerEnvironment: (dirs) => ({
        BUN_OPTIONS: `--preload=${fileURLToPath(new URL('../../support/canvas-sync-fault.ts', import.meta.url))}`,
        GARCON_TEST_CANVAS_DIRECTORY: join(dirs.workspace, 'chat-canvases'),
        GARCON_TEST_CANVAS_SYNC_FAILURE: join(dirs.root, 'fail-canvas-sync'),
      }),
    });
  }, 30_000);
}
