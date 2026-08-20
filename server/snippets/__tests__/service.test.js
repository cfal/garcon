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

  it('creates, updates, and removes with post-write invalidations', async () => {
    const { service, events } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'review',
        template: 'Review {{arguments}}',
        defaultArguments: 'changes',
      },
    });
    await service.update({
      expectedRevision: 1,
      id: 'snippet-a',
      snippet: {
        shortName: 'review',
        template: 'Updated {{arguments}}',
        defaultArguments: 'staged changes',
      },
    });
    await service.remove({ expectedRevision: 2, id: 'snippet-a' });
    expect(events).toEqual(['created', 'updated', 'removed']);
  });

  it('expands chat and project contexts without emitting invalidations', async () => {
    const { service, events } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'review',
        template: 'Review {{arguments}} in {{project_path}}',
        defaultArguments: 'changes',
      },
    });
    events.length = 0;
    expect(
      await service.expand({
        shortName: 'review',
        arguments: { type: 'value', value: 'contracts' },
        context: { type: 'chat', chatId: 'chat-a' },
      }),
    ).toMatchObject({
      snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
      contextProjectPath: '/registered/repo',
      expandedText: 'Review contracts in /canonical/registered/repo',
    });
    expect(
      await service.expand({
        shortName: 'review',
        arguments: { type: 'value', value: 'routes' },
        context: { type: 'project', projectPath: '/draft/repo' },
      }),
    ).toMatchObject({
      contextProjectPath: '/draft/repo',
      expandedText: 'Review routes in /canonical/draft/repo',
    });
    expect(events).toEqual([]);
  });

  it('uses the saved default only for omitted arguments', async () => {
    const { service } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'review',
        template: '{{arguments}} / {{arguments}} / {{project_path}}',
        defaultArguments: '{{project_path}} changes',
      },
    });

    await expect(
      service.expand({
        shortName: 'review',
        arguments: { type: 'default' },
        context: { type: 'project', projectPath: '/draft/repo' },
      }),
    ).resolves.toMatchObject({
      expandedText: '{{project_path}} changes / {{project_path}} changes / /canonical/draft/repo',
    });
    await expect(
      service.expand({
        shortName: 'review',
        arguments: { type: 'value', value: '' },
        context: { type: 'project', projectPath: '/draft/repo' },
      }),
    ).resolves.toMatchObject({ expandedText: ' /  / /canonical/draft/repo' });
    await expect(
      service.expand({
        shortName: 'review',
        arguments: { type: 'value', value: '  ' },
        context: { type: 'project', projectPath: '/draft/repo' },
      }),
    ).resolves.toMatchObject({
      expandedText: '   /    / /canonical/draft/repo',
    });
  });

  it('rejects unusable defaults and maps oversized default expansion errors', async () => {
    const { service } = await serviceFixture();
    await expect(
      service.create({
        expectedRevision: 0,
        snippet: {
          shortName: 'invalid',
          template: 'No arguments token',
          defaultArguments: 'unused',
        },
      }),
    ).rejects.toMatchObject({ code: 'SNIPPET_VALIDATION_FAILED', status: 400 });

    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'large',
        template: '{{arguments}}{{arguments}}{{arguments}}',
        defaultArguments: 'x'.repeat(32_000),
      },
    });
    await expect(
      service.expand({
        shortName: 'large',
        arguments: { type: 'default' },
        context: { type: 'project', projectPath: '/draft/repo' },
      }),
    ).rejects.toMatchObject({
      code: 'SNIPPET_EXPANSION_TOO_LONG',
      status: 422,
    });
  });

  it('expands chat IDs only when an existing chat supplies the context', async () => {
    const { service } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'handoff',
        template: 'Reply to {{chat_id}} about {{arguments}}',
        defaultArguments: '',
      },
    });

    await expect(
      service.expand({
        shortName: 'handoff',
        arguments: { type: 'value', value: 'the review' },
        context: { type: 'chat', chatId: 'chat-a' },
      }),
    ).resolves.toMatchObject({
      expandedText: 'Reply to chat-a about the review',
    });
    await expect(
      service.expand({
        shortName: 'handoff',
        arguments: { type: 'value', value: 'the review' },
        context: { type: 'project', projectPath: '/draft/repo' },
      }),
    ).rejects.toMatchObject({ code: 'SNIPPET_CHAT_ID_REQUIRED', status: 422 });
  });

  it('rejects missing chats and unknown snippets', async () => {
    const { service } = await serviceFixture();
    await expect(
      service.expand({
        shortName: 'missing',
        arguments: { type: 'value', value: '' },
        context: { type: 'chat', chatId: 'chat-a' },
      }),
    ).rejects.toMatchObject({ code: 'SNIPPET_NOT_FOUND', status: 404 });
    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'review',
        template: 'Review',
        defaultArguments: '',
      },
    });
    await expect(
      service.expand({
        shortName: 'review',
        arguments: { type: 'value', value: '' },
        context: { type: 'chat', chatId: 'missing' },
      }),
    ).rejects.toMatchObject({ code: 'SNIPPET_CHAT_NOT_FOUND', status: 404 });
  });

  it('does not invalidate clients when a mutation fails', async () => {
    const { service, events } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'review',
        template: 'Review',
        defaultArguments: '',
      },
    });
    events.length = 0;

    await expect(
      service.create({
        expectedRevision: 0,
        snippet: {
          shortName: 'other',
          template: 'Other',
          defaultArguments: '',
        },
      }),
    ).rejects.toMatchObject({ code: 'SNIPPET_REVISION_CONFLICT' });
    expect(events).toEqual([]);
  });

  it('checks the expected revision before reporting a deleted update target', async () => {
    const { service, events } = await serviceFixture();
    await service.create({
      expectedRevision: 0,
      snippet: {
        shortName: 'review',
        template: 'Review',
        defaultArguments: '',
      },
    });
    await service.remove({ expectedRevision: 1, id: 'snippet-a' });
    events.length = 0;

    const update = {
      id: 'snippet-a',
      snippet: {
        shortName: 'review',
        template: 'Updated',
        defaultArguments: '',
      },
    };
    await expect(service.update({ ...update, expectedRevision: 1 })).rejects.toMatchObject({
      code: 'SNIPPET_REVISION_CONFLICT',
      status: 409,
      retryable: true,
    });
    await expect(service.update({ ...update, expectedRevision: 2 })).rejects.toMatchObject({
      code: 'SNIPPET_NOT_FOUND',
      status: 404,
    });
    expect(events).toEqual([]);
  });

  it('maps real path-boundary failures to snippet path errors', async () => {
    const projectBase = path.join(os.tmpdir(), `garcon-snippet-projects-${randomUUID()}`);
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
    await expect(projectPaths.resolve(path.join(projectBase, 'missing'))).rejects.toMatchObject({
      code: 'SNIPPET_PROJECT_PATH_NOT_FOUND',
      status: 404,
    });
    await expect(projectPaths.resolve(path.dirname(projectBase))).rejects.toMatchObject({
      code: 'SNIPPET_PROJECT_PATH_OUTSIDE_BASE',
      status: 403,
    });
  });
});
