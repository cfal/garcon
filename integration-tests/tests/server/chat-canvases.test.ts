import { describe, expect, test } from 'bun:test';
import type { ChatCanvas, CanvasListResponse, CanvasContent } from '../../../common/chat-canvas.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

describe('chat canvas API', () => {
  test('keeps healthy boards available beside unreadable filesystem entries', async () => {
    await withIntegrationFixture('chat-canvases-file-types', async (fixture) => {
      const endpoint = '/api/v1/chat-canvases';
      const content: CanvasContent = { title: 'Healthy', nodes: [], connections: [] };
      await fixture.client.post(endpoint, { id: 'healthy', content });
      await mkdir(join(fixture.dirs.workspace, 'chat-canvases/directory.json'));
      await symlink('loop.json', join(fixture.dirs.workspace, 'chat-canvases/loop.json'));
      const catalog = await fixture.client.get<CanvasListResponse>(endpoint);
      expect(catalog.canvases.map((entry) => entry.id)).toEqual(['healthy']);
      expect(catalog.unavailableIds).toEqual(['directory', 'loop']);
      for (const id of catalog.unavailableIds) {
        await expect(fixture.client.get(`${endpoint}?id=${id}`)).rejects.toMatchObject({ status: 500 });
        await expect(fixture.client.post(endpoint, { id, content })).rejects.toMatchObject({ status: 500 });
      }
      expect((await fixture.client.get<CanvasListResponse>(endpoint)).unavailableIds).toEqual(['directory', 'loop']);
    });
  });

  test('persists boards across restart and rejects conflicting or invalid writes', async () => {
    await withIntegrationFixture('chat-canvases', async (fixture) => {
      const endpoint = '/api/v1/chat-canvases';
      const content: CanvasContent = { title: 'Synthetic work', nodes: [
        { id: 'box', type: 'box', title: 'Research', position: { x: -100, y: 20 } },
        { id: 'card', type: 'chat', chatId: '1780000000000001', boxId: 'box', position: { x: 0, y: 0 } },
      ], connections: [] };
      const created = await fixture.client.post<ChatCanvas>(endpoint, { id: 'synthetic-canvas', content });
      expect(created.revision).toBe(1);
      const changed = { ...content, title: 'Revised work' };
      const updated = await fixture.client.put<ChatCanvas>(endpoint, { id: created.id, expectedRevision: 1, content: changed });
      await expect(fixture.client.put(endpoint, { id: created.id, expectedRevision: 1, content })).rejects.toMatchObject({ status: 409 });
      await expect(fixture.client.put(endpoint, { id: created.id, expectedRevision: 2, content: { ...changed, nodes: [content.nodes[1]] } })).rejects.toMatchObject({ status: 400 });
      await expect(fixture.client.get(`${endpoint}?id=..%2Foutside`)).rejects.toMatchObject({ status: 400 });
      await fixture.restartGarcon();
      expect(await fixture.client.get<ChatCanvas>(`${endpoint}?id=${created.id}`)).toEqual(updated);
      expect((await fixture.client.get<CanvasListResponse>(endpoint)).canvases).toEqual([
        { id: created.id, title: changed.title, revision: 2, updatedAt: updated.updatedAt },
      ]);
      await expect(fixture.client.delete(endpoint, { id: created.id, expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
      await fixture.client.delete(endpoint, { id: created.id, expectedRevision: 2 });
      expect((await fixture.client.get<CanvasListResponse>(endpoint)).canvases).toEqual([]);

      const damaged = join(fixture.dirs.workspace, 'chat-canvases/damaged.json');
      await writeFile(damaged, '{broken');
      await writeFile(join(fixture.dirs.workspace, 'chat-canvases/backup copy.json'), '{unrelated');
      expect(await fixture.client.get<CanvasListResponse>(endpoint)).toEqual({ canvases: [], unavailableIds: ['damaged'] });
      const healthy = await fixture.client.post<ChatCanvas>(endpoint, { id: 'healthy', content });
      expect((await fixture.client.get<CanvasListResponse>(endpoint)).canvases[0].id).toBe(healthy.id);
      await expect(fixture.client.put(endpoint, { id: 'damaged', expectedRevision: 1, content })).rejects.toMatchObject({ status: 500 });
      expect(await readFile(damaged, 'utf8')).toBe('{broken');
    });
  });
});
