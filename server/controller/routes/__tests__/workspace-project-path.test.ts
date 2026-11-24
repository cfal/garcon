import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectPathPreferenceRoutes } from '../project-path-preferences.js';
import { buildRemoteSettingsSnapshot } from '../../settings/remote-snapshot.js';
import { SettingsStore } from '../../settings/store.js';
import type { AgentRegistryServiceContract } from '../../agents/registry.js';
import type { RouteMap, RouteHandler } from '../../lib/http-route-types.js';

type ProjectPathSettings = Pick<SettingsStore, 'getRemoteSettingsSnapshotSource' | 'removeProjectPathFromList' | 'setPathSettings'>;
type SnapshotAgents = Pick<AgentRegistryServiceContract, 'getAgentAuthStatusMap' | 'getAgentReadinessMap' | 'getAgentCatalogEntries'>;

function projectPathRoutes(settings: ProjectPathSettings, agents: SnapshotAgents, projectBasePath: string): RouteMap {
  const options = { settings, agents, projectBasePath };
  return {
    ...createProjectPathPreferenceRoutes(options),
    '/api/v1/app/settings': { GET: async () => Response.json(await buildRemoteSettingsSnapshot(options)) },
  };
}

function remoteSettingsSource(overrides: Partial<ReturnType<SettingsStore['getRemoteSettingsSnapshotSource']>> = {}): ReturnType<SettingsStore['getRemoteSettingsSnapshotSource']> {
  return { ...new SettingsStore(join(tmpdir(), 'garcon-project-path-defaults')).getRemoteSettingsSnapshotSource(), ...overrides };
}

function createWorkspaceFixture() {
  return {
    settings: {
      getRemoteSettingsSnapshotSource: mock<SettingsStore['getRemoteSettingsSnapshotSource']>(() => remoteSettingsSource()),
      removeProjectPathFromList: mock<SettingsStore['removeProjectPathFromList']>(async () => {}),
      setPathSettings: mock<SettingsStore['setPathSettings']>(async () => remoteSettingsSource().paths),
    } satisfies ProjectPathSettings,
    agents: {
      getAgentAuthStatusMap: mock<AgentRegistryServiceContract['getAgentAuthStatusMap']>(async () => ({})),
      getAgentReadinessMap: mock<AgentRegistryServiceContract['getAgentReadinessMap']>(async () => ({})),
      getAgentCatalogEntries: mock<AgentRegistryServiceContract['getAgentCatalogEntries']>(async () => []),
    } satisfies SnapshotAgents,
  };
}

function makeRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}


const REMOTE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ROUTE = '/api/v1/app/settings/project-path';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('DELETE project path preferences', () => {
  let ctx: ReturnType<typeof createWorkspaceFixture>;
  let handler: RouteHandler;
  beforeEach(() => {
    ctx = createWorkspaceFixture();
    handler = projectPathRoutes(ctx.settings, ctx.agents, '/projects')[ROUTE]!.DELETE!;
  });

  it('passes only the explicit identity to the domain and returns its canonical snapshot', async () => {
    ctx.settings.removeProjectPathFromList.mockImplementation(async () => {
      ctx.settings.getRemoteSettingsSnapshotSource.mockImplementation(() => remoteSettingsSource({
        version: 3, paths: { pinnedProjectPaths: ['/new/pin'], browseStartPath: '/default', recentProjectPaths: ['/new/recent'] },
      }));
    });
    const request = { executorId: REMOTE, projectPath: '/projects/atlas ' };
    const response = await handler(makeRequest(`http://localhost${ROUTE}`, 'DELETE', request), new URL(`http://localhost${ROUTE}`));
    expect(response.status).toBe(200);
    expect(ctx.settings.removeProjectPathFromList).toHaveBeenCalledTimes(1);
    expect(ctx.settings.removeProjectPathFromList).toHaveBeenCalledWith(request);
    expect(ctx.settings.setPathSettings).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ success: true, settings: { version: 3, paths: {
      pinnedProjectPaths: ['/new/pin'], recentProjectPaths: ['/new/recent'], browseStartPath: '/default',
    } } });
  });

  it.each([null, [], {}, { projectPath: '/project' }, { executorId: null, projectPath: '/project' },
    { executorId: 'invalid', projectPath: '/project' }, { executorId: 'local', projectPath: '' },
    { executorId: 'local', projectPath: '/project', pinnedPaths: [] },
  ].map(request => ({ request })))('rejects invalid identity before mutation: %j', async ({ request }) => {
    const response = await handler(makeRequest(`http://localhost${ROUTE}`, 'DELETE', request), new URL(`http://localhost${ROUTE}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, errorCode: 'INVALID_PROJECT_PATH_REMOVAL' });
    expect(ctx.settings.removeProjectPathFromList).not.toHaveBeenCalled();
  });

  it('reports persistence failure instead of returning optimistic success', async () => {
    ctx.settings.removeProjectPathFromList.mockRejectedValueOnce(new Error('Synthetic save failure'));
    const response = await handler(makeRequest(`http://localhost${ROUTE}`, 'DELETE', { executorId: 'local', projectPath: '/project' }), new URL(`http://localhost${ROUTE}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
  });
});

it.each(['local', REMOTE])('HTTP removal preserves changes made after a stale client snapshot for %s', async executorId => {
  const root = await mkdtemp(join(tmpdir(), 'garcon-project-path-http-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  await settings.setPathSettings({
    pinnedProjectPaths: ['D:\\projects\\atlas', '/local/keep'],
    recentProjectPaths: ['D:/projects/atlas', '/local/recent'],
    browseStartPath: '/local/default',
    byExecutor: {
      [REMOTE]: { defaultPath: '/remote/default', pinnedPaths: ['D:\\projects\\atlas', '/remote/keep'] },
      [OTHER]: { pinnedPaths: ['D:/projects/atlas'] },
    },
  });
  await settings.recordChatStartup({ executorId: REMOTE, agentId: 'test', model: 'synthetic', projectPath: 'D:/projects/atlas' });
  const { agents } = createWorkspaceFixture();
  const routes = projectPathRoutes(settings, agents, '/projects');
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request, server) {
    const url = new URL(request.url);
    const handler = routes[url.pathname]?.[request.method];
    return handler ? handler(request, url, server) : new Response(null, { status: 404 });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const stale = await (await fetch(`${base}/api/v1/app/settings`)).json();
    expect(stale.paths.recentProjectPaths).toContain('D:/projects/atlas');
    await settings.recordChatStartup({ executorId, agentId: 'test', model: 'synthetic', projectPath: '/new/recent' });
    await settings.setPathSettings(executorId === 'local'
      ? { pinnedProjectPaths: ['D:\\projects\\atlas', '/local/keep', '/new/pin'] }
      : { byExecutor: { [executorId]: { pinnedPaths: ['D:\\projects\\atlas', '/remote/keep', '/new/pin'] } } });
    const request = { executorId, projectPath: 'D:/projects/atlas' };
    const response = await fetch(`${base}${ROUTE}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    const paths = body.settings.paths;
    const owner = executorId === 'local'
      ? { pinnedPaths: paths.pinnedProjectPaths, recentPaths: paths.recentProjectPaths }
      : paths.byExecutor[executorId];
    expect(owner.pinnedPaths).toEqual(expect.arrayContaining(['/new/pin', executorId === 'local' ? '/local/keep' : '/remote/keep']));
    expect(owner.pinnedPaths).not.toContain('D:\\projects\\atlas');
    expect(owner.recentPaths).toContain('/new/recent');
    expect(owner.recentPaths).not.toContain('D:/projects/atlas');
    expect(paths.byExecutor[OTHER].pinnedPaths).toEqual(['D:/projects/atlas']);
    expect(paths.browseStartPath).toBe('/local/default');
    expect(paths.byExecutor[REMOTE].defaultPath).toBe('/remote/default');
    const repeated = await fetch(`${base}${ROUTE}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect((await repeated.json()).settings.version).toBe(body.settings.version);
    const restarted = new SettingsStore(root);
    await restarted.init();
    expect(restarted.getPathSettings()).toEqual(settings.getPathSettings());
  } finally {
    server.stop(true);
  }
});
