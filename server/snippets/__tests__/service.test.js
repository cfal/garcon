import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { resetServerConfigForTests } from '../../config.ts';
import { SnippetProjectPathService, SnippetService } from '../service.ts';
import { SnippetStore } from '../store.ts';
import { PreambleStore } from '../../preambles/store.ts';
import { SnippetShortNameCoordinator } from '../short-name-coordinator.ts';
import { PreambleService } from '../../preambles/service.ts';

const createdDirs = [];
const originalProjectBaseDir = process.env.GARCON_PROJECT_BASE_DIR;
const REGISTERED_CHAT_ID = '1787471053739199';
const PROSPECTIVE_CHAT_ID = '1787471053739200';
const MISSING_CHAT_ID = '1787471053739201';

async function serviceFixture() {
  const dir = path.join(os.tmpdir(), `garcon-snippet-service-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  const store = new SnippetStore(dir);
  await store.init();
  const preambleStore = new PreambleStore(dir);
  await preambleStore.init();
  const snippetShortNames = new SnippetShortNameCoordinator({
    snippets: () => store.snapshot().snippets,
    preambles: () => preambleStore.snapshot().preambles,
  });
  const events = [];
  const chatLookups = [];
  const service = new SnippetService({
    store,
    preambles: preambleStore,
    snippetShortNames,
    chats: {
      getChat(id) {
        chatLookups.push(id);
        return id === REGISTERED_CHAT_ID ? { projectPath: '/registered/repo' } : null;
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
  return { dir, service, store, preambleStore, snippetShortNames, events, chatLookups };
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

  it('expands registered and prospective chat contexts without emitting invalidations', async () => {
    const { service, events, chatLookups } = await serviceFixture();
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
        context: {
          type: 'chat',
          chatId: REGISTERED_CHAT_ID,
          projectPath: '/ignored',
        },
      }),
    ).toMatchObject({
      source: 'snippet',
      sourceId: 'snippet-a',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
      contextProjectPath: '/registered/repo',
      expandedText: 'Review contracts in /canonical/registered/repo',
    });
    expect(
      await service.expand({
        shortName: 'review',
        arguments: { type: 'value', value: 'routes' },
        context: {
          type: 'new-chat',
          chatId: PROSPECTIVE_CHAT_ID,
          projectPath: '/draft/repo',
        },
      }),
    ).toMatchObject({
      contextProjectPath: '/draft/repo',
      expandedText: 'Review routes in /canonical/draft/repo',
    });
    expect(chatLookups).toEqual([REGISTERED_CHAT_ID]);
    expect(events).toEqual([]);
  });

  it('expands named preambles with preamble token semantics regardless of automatic eligibility', async () => {
    const { service, preambleStore } = await serviceFixture();
    await preambleStore.create({
      id: '00000000-0000-4000-8000-000000000001',
      enabled: false,
      title: 'Manual context',
      snippetShortName: 'context',
      content: 'Chat {{chat_id}} / {{arguments}} / {{project_path}} / \\{{chat_id}}',
      scope: {
        type: 'project-paths',
        rules: [{ projectPath: '/different/project', includeNested: false }],
      },
      agentIds: ['codex'],
      tagFilter: { mode: 'all', tags: ['manual'] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, 0);

    await expect(service.expand({
      shortName: 'context',
      arguments: { type: 'value', value: 'ignored' },
      context: {
        type: 'new-chat',
        chatId: PROSPECTIVE_CHAT_ID,
        projectPath: '/draft/repo',
      },
    })).resolves.toEqual({
      success: true,
      source: 'preamble',
      sourceId: '00000000-0000-4000-8000-000000000001',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
      shortName: 'context',
      contextProjectPath: '/draft/repo',
      expandedText: `Chat ${PROSPECTIVE_CHAT_ID} / {{arguments}} / {{project_path}} / {{chat_id}}`,
    });
  });

  it('serializes cross-catalog names and releases them on clear or remove', async () => {
    const { service, preambleStore, snippetShortNames } = await serviceFixture();
    const preambles = new PreambleService({
      store: preambleStore,
      snippetShortNames,
      projectPaths: { resolve: async (projectPath) => projectPath },
      newId: () => '00000000-0000-4000-8000-000000000001',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const preambleDefinition = {
      enabled: true,
      title: 'Context',
      snippetShortName: 'shared',
      content: 'Context',
      scope: { type: 'global' },
    };

    const results = await Promise.allSettled([
      service.create({
        expectedRevision: 0,
        snippet: { shortName: 'shared', template: 'Snippet', defaultArguments: '' },
      }),
      preambles.create({ expectedRevision: 0, preamble: preambleDefinition }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    if (service.snapshot().snippets.length > 0) {
      await service.remove({ expectedRevision: 1, id: 'snippet-a' });
      await expect(preambles.create({
        expectedRevision: 0,
        preamble: preambleDefinition,
      })).resolves.toMatchObject({ preambles: [{ snippetShortName: 'shared' }] });
    } else {
      await preambles.update({
        expectedRevision: 1,
        id: '00000000-0000-4000-8000-000000000001',
        preamble: { ...preambleDefinition, snippetShortName: undefined },
      });
      await expect(service.create({
        expectedRevision: 0,
        snippet: { shortName: 'shared', template: 'Snippet', defaultArguments: '' },
      })).resolves.toMatchObject({ snippets: [{ shortName: 'shared' }] });
    }
  });

  it('keeps a post-rename snippet name reserved across catalogs', async () => {
    const { dir, service, store, preambleStore, snippetShortNames, events } = await serviceFixture();
    const preambles = new PreambleService({
      store: preambleStore,
      snippetShortNames,
      projectPaths: { resolve: async (projectPath) => projectPath },
      newId: () => '00000000-0000-4000-8000-000000000001',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await service.create({
      expectedRevision: 0,
      snippet: { shortName: 'before', template: 'Snippet', defaultArguments: '' },
    });

    const originalOpen = fs.open;
    fs.open = async (target, flags, ...rest) => {
      if (flags === 'r' && typeof target === 'string' && target === dir) {
        throw new Error('injected directory sync failure');
      }
      return originalOpen(target, flags, ...rest);
    };
    try {
      await expect(service.update({
        expectedRevision: 1,
        id: 'snippet-a',
        snippet: { shortName: 'shared', template: 'Updated', defaultArguments: '' },
      })).rejects.toMatchObject({ code: 'SNIPPET_CATALOG_SAVE_UNKNOWN' });
    } finally {
      fs.open = originalOpen;
    }

    expect(store.snapshot().snippets[0].shortName).toBe('shared');
    expect(events).toEqual(['created', 'updated']);
    await expect(preambles.create({
      expectedRevision: 0,
      preamble: {
        enabled: true,
        title: 'Context',
        snippetShortName: 'shared',
        content: 'Context',
        scope: { type: 'global' },
      },
    })).rejects.toMatchObject({ code: 'PREAMBLE_SNIPPET_NAME_CONFLICT' });
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
        context: {
          type: 'new-chat',
          chatId: PROSPECTIVE_CHAT_ID,
          projectPath: '/draft/repo',
        },
      }),
    ).resolves.toMatchObject({
      expandedText: '{{project_path}} changes / {{project_path}} changes / /canonical/draft/repo',
    });
    await expect(
      service.expand({
        shortName: 'review',
        arguments: { type: 'value', value: '' },
        context: {
          type: 'new-chat',
          chatId: PROSPECTIVE_CHAT_ID,
          projectPath: '/draft/repo',
        },
      }),
    ).resolves.toMatchObject({ expandedText: ' /  / /canonical/draft/repo' });
    await expect(
      service.expand({
        shortName: 'review',
        arguments: { type: 'value', value: '  ' },
        context: {
          type: 'new-chat',
          chatId: PROSPECTIVE_CHAT_ID,
          projectPath: '/draft/repo',
        },
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
        context: {
          type: 'new-chat',
          chatId: PROSPECTIVE_CHAT_ID,
          projectPath: '/draft/repo',
        },
      }),
    ).rejects.toMatchObject({
      code: 'SNIPPET_EXPANSION_TOO_LONG',
      status: 422,
    });
  });

  it('expands the supplied ID for both registered and prospective chats', async () => {
    const { service, chatLookups } = await serviceFixture();
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
        context: { type: 'chat', chatId: REGISTERED_CHAT_ID },
      }),
    ).resolves.toMatchObject({
      expandedText: `Reply to ${REGISTERED_CHAT_ID} about the review`,
    });
    await expect(
      service.expand({
        shortName: 'handoff',
        arguments: { type: 'value', value: 'the review' },
        context: {
          type: 'new-chat',
          chatId: PROSPECTIVE_CHAT_ID,
          projectPath: '/draft/repo',
        },
      }),
    ).resolves.toMatchObject({
      expandedText: `Reply to ${PROSPECTIVE_CHAT_ID} about the review`,
    });
    expect(chatLookups).toEqual([REGISTERED_CHAT_ID]);
  });

  it('rejects missing chats and unknown snippets', async () => {
    const { service } = await serviceFixture();
    await expect(
      service.expand({
        shortName: 'missing',
        arguments: { type: 'value', value: '' },
        context: { type: 'chat', chatId: REGISTERED_CHAT_ID },
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
        context: { type: 'chat', chatId: MISSING_CHAT_ID },
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
