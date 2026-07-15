import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { resetServerConfigForTests } from '../../config.ts';
import { SnippetProjectPathService, SnippetService } from '../service.ts';
import { SnippetStore } from '../store.ts';

const createdDirs = [];
const originalProjectBaseDir = process.env.GARCON_PROJECT_BASE_DIR;

async function serviceFixture() {
  const dir = path.join(os.tmpdir(), `garcon-snippet-service-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  const store = new SnippetStore(dir);
  await store.init();
  const events = [];
  const service = new SnippetService({
    store,
    chats: {
      getChat(id) {
        return id === 'chat-a' ? { projectPath: '/registered/repo' } : null;
      },
    },
    projectPaths: {
      async resolve(projectPath) {
        return `/canonical${projectPath}`;
      },
    },
    newId: () => 'snippet-a',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  service.onInvalidated((reason) => events.push(reason));
  return { service, events };
}

describe('snippet service', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    if (originalProjectBaseDir === undefined) {
      delete process.env.GARCON_PROJECT_BASE_DIR;
    } else {
      process.env.GARCON_PROJECT_BASE_DIR = originalProjectBaseDir;
    }
    resetServerConfigForTests();
  });

  it('creates, updates, reorders, and removes with post-write invalidations', async () => {
    const { service, events } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: { shortName: 'review', template: 'Review {{arguments}}' },
    });
    await service.update({
      expectedRevision: 1,
      id: 'snippet-a',
      snippet: { shortName: 'review', template: 'Updated {{arguments}}' },
    });
    await service.reorder({
      expectedRevision: 2,
      orderedSnippetIds: ['snippet-a'],
    });
    await service.remove({ expectedRevision: 3, id: 'snippet-a' });
    expect(events).toEqual(['created', 'updated', 'reordered', 'removed']);
  });

  it('expands chat and project contexts without emitting invalidations', async () => {
    const { service, events } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'review',
        template: 'Review {{arguments}} in {{project_path}}',
      },
    });
    events.length = 0;
    expect(
      await service.expand({
        shortName: 'review',
        arguments: 'contracts',
        context: { type: 'chat', chatId: 'chat-a' },
      }),
    ).toMatchObject({
      expandedText: 'Review contracts in /canonical/registered/repo',
    });
    expect(
      await service.expand({
        shortName: 'review',
        arguments: 'routes',
        context: { type: 'project', projectPath: '/draft/repo' },
      }),
    ).toMatchObject({ expandedText: 'Review routes in /canonical/draft/repo' });
    expect(events).toEqual([]);
  });

  it('rejects missing chats and unknown snippets', async () => {
    const { service } = await serviceFixture();
    await expect(
      service.expand({
        shortName: 'missing',
        arguments: '',
        context: { type: 'chat', chatId: 'chat-a' },
      }),
    ).rejects.toMatchObject({ code: 'SNIPPET_NOT_FOUND', status: 404 });
    await service.create({
      expectedRevision: 0,
      snippet: { shortName: 'review', template: 'Review' },
    });
    await expect(
      service.expand({
        shortName: 'review',
        arguments: '',
        context: { type: 'chat', chatId: 'missing' },
      }),
    ).rejects.toMatchObject({ code: 'SNIPPET_CHAT_NOT_FOUND', status: 404 });
  });

  it('does not invalidate clients when a mutation fails', async () => {
    const { service, events } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: { shortName: 'review', template: 'Review' },
    });
    events.length = 0;

    await expect(
      service.create({
        expectedRevision: 0,
        snippet: { shortName: 'other', template: 'Other' },
      }),
    ).rejects.toMatchObject({ code: 'SNIPPET_REVISION_CONFLICT' });
    expect(events).toEqual([]);
  });

  it('checks the expected revision before reporting a deleted update target', async () => {
    const { service, events } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: { shortName: 'review', template: 'Review' },
    });
    await service.remove({ expectedRevision: 1, id: 'snippet-a' });
    events.length = 0;

    const update = {
      id: 'snippet-a',
      snippet: { shortName: 'review', template: 'Updated' },
    };
    await expect(
      service.update({ ...update, expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: 'SNIPPET_REVISION_CONFLICT',
      status: 409,
      retryable: true,
    });
    await expect(
      service.update({ ...update, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'SNIPPET_NOT_FOUND', status: 404 });
    expect(events).toEqual([]);
  });

  it('maps real path-boundary failures to snippet path errors', async () => {
    const projectBase = path.join(
      os.tmpdir(),
      `garcon-snippet-projects-${randomUUID()}`,
    );
    await fs.mkdir(projectBase, { recursive: true });
    createdDirs.push(projectBase);
    process.env.GARCON_PROJECT_BASE_DIR = projectBase;
    resetServerConfigForTests();
    const projectPaths = new SnippetProjectPathService();

    const loopPath = path.join(projectBase, 'loop');
    await fs.symlink('loop', loopPath);
    await expect(projectPaths.resolve(loopPath)).rejects.toMatchObject({
      code: 'SNIPPET_PROJECT_PATH_NOT_FOUND',
      status: 404,
    });
    await expect(
      projectPaths.resolve(path.join(projectBase, 'missing')),
    ).rejects.toMatchObject({
      code: 'SNIPPET_PROJECT_PATH_NOT_FOUND',
      status: 404,
    });
    await expect(
      projectPaths.resolve(path.dirname(projectBase)),
    ).rejects.toMatchObject({
      code: 'SNIPPET_PROJECT_PATH_OUTSIDE_BASE',
      status: 403,
    });
  });
});
