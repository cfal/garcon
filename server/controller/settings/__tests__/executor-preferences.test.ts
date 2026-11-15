import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../store.js';
import { GENERATION_UI_SETTING_KEYS, normalizeRemoteSettingsSnapshot, parseExecutorProjectPreferences } from '../../../../common/settings.js';
import { writeJsonFileAtomic } from '../../../common/json-file-store.ts';
import { resolveEffectiveGenerationConfig } from '../generation-effective.js';
import { buildRemoteSettingsSnapshot } from '../remote-snapshot.js';
import type { AgentRegistryServiceContract } from '../../agents/registry.js';

const EXECUTOR = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test('mixed malformed stored owners remain recoverable while valid owners migrate, update and reload', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-mixed-project-preferences-'));
  roots.push(root);
  const malformedId = '33333333-3333-4333-8333-333333333333';
  const malformed = { pinnedPaths: ['/recover', 42], recentPaths: ['/recover-recent'], defaultPath: '/recover-default' };
  const pins = Array.from({ length: 7 }, (_, index) => `/remote-${index}`);
  const byExecutor = {
    [EXECUTOR]: { pinnedPaths: pins, recentPaths: ['/recent'] },
    [malformedId]: malformed,
    'invalid-owner': ['preserve', '/raw-path'],
  };
  await writeFile(join(root, 'project-settings.json'), JSON.stringify({ paths: { byExecutor } }));
  let settings = new SettingsStore(root);
  await settings.init();
  const agents = {
    getAgentAuthStatusMap: async () => ({}),
    getAgentReadinessMap: async () => ({}),
    getAgentCatalogEntries: async () => [],
  } satisfies Pick<AgentRegistryServiceContract, 'getAgentAuthStatusMap' | 'getAgentReadinessMap' | 'getAgentCatalogEntries'>;
  const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, projectBasePath: '/project' });
  expect(snapshot.paths.byExecutor).toEqual({ [EXECUTOR]: { pinnedPaths: pins.slice(-5), recentPaths: [...pins.slice(0, 2), '/recent'] } });
  expect(normalizeRemoteSettingsSnapshot(snapshot)).not.toBeNull();
  await settings.setPathSettings({ browseStartPath: '/local', byExecutor: { [EXECUTOR]: { pinnedPaths: [...pins.slice(-5), '/new'] } } });
  await settings.recordChatStartup({ executorId: EXECUTOR, agentId: 'test', model: 'synthetic', projectPath: '/new-recent' });
  await settings.removeProjectPathFromList({ executorId: EXECUTOR, projectPath: '/remote-3' });
  await expect(settings.setPathSettings({ byExecutor: { [malformedId]: { defaultPath: '/overwrite' } } }))
    .rejects.toThrow('Invalid executor project preferences');
  settings = new SettingsStore(root);
  await settings.init();
  const disk = JSON.parse(await readFile(join(root, 'project-settings.json'), 'utf8'));
  expect(disk.paths.byExecutor[malformedId]).toEqual(malformed);
  expect(disk.paths.byExecutor['invalid-owner']).toEqual(byExecutor['invalid-owner']);
  expect(disk.paths.byExecutor[EXECUTOR]).toEqual({
    pinnedPaths: ['/remote-4', '/remote-5', '/remote-6', '/new'],
    recentPaths: ['/new-recent', '/remote-2', '/remote-0', '/remote-1', '/recent'],
  });
  expect(settings.getPathSettings().byExecutor).toEqual(disk.paths.byExecutor);
});

test('pin replacement retains five pins per machine and every saved project through restart', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-pin-limit-'));
  roots.push(root);
  let settings = new SettingsStore(root);
  await settings.init();
  const initialPins = ['/z', '/b', '/c', '/d', '/a'];
  await settings.setPathSettings({
    pinnedProjectPaths: initialPins,
    byExecutor: { [EXECUTOR]: { pinnedPaths: initialPins } },
  });
  for (let index = 0; index < 14; index += 1) {
    for (const executorId of ['local', EXECUTOR]) {
      await settings.recordChatStartup({ executorId, agentId: 'test', model: 'synthetic', projectPath: `/recent-${index}` });
    }
  }
  await settings.setPathSettings({ pinnedProjectPaths: ['/a', '/b', '/c', '/d', '/z', '/new'] });
  settings = new SettingsStore(root);
  await settings.init();
  expect(settings.getPathSettings().pinnedProjectPaths).toEqual(['/b', '/c', '/d', '/a', '/new']);
  expect(settings.getPathSettings().byExecutor?.[EXECUTOR]?.pinnedPaths).toEqual(initialPins);
  await settings.setPathSettings({
    pinnedProjectPaths: ['/a', '/b', '/c', '/d', '/new', '/next'],
    byExecutor: { [EXECUTOR]: { pinnedPaths: [...initialPins, '/remote-new'] } },
  });
  const paths = settings.getPathSettings();
  expect(paths.pinnedProjectPaths).toEqual(['/c', '/d', '/a', '/new', '/next']);
  expect(paths.byExecutor?.[EXECUTOR]?.pinnedPaths).toEqual(['/b', '/c', '/d', '/a', '/remote-new']);
  expect(paths.recentProjectPaths).toEqual(['/b', '/z', ...Array.from({ length: 14 }, (_, index) => `/recent-${13 - index}`)]);
  expect(paths.byExecutor?.[EXECUTOR]?.recentPaths).toEqual(['/z', ...Array.from({ length: 14 }, (_, index) => `/recent-${13 - index}`)]);
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getPathSettings()).toEqual(paths);
  const agents = {
    getAgentAuthStatusMap: async () => ({}),
    getAgentReadinessMap: async () => ({}),
    getAgentCatalogEntries: async () => [],
  } satisfies Pick<AgentRegistryServiceContract, 'getAgentAuthStatusMap' | 'getAgentReadinessMap' | 'getAgentCatalogEntries'>;
  const snapshot = await buildRemoteSettingsSnapshot({ settings: restarted, agents, projectBasePath: '/project' });
  expect(snapshot.paths.pinnedProjectPaths).toEqual(paths.pinnedProjectPaths);
  expect(snapshot.paths.byExecutor?.[EXECUTOR]).toEqual(paths.byExecutor?.[EXECUTOR]);
});

test('legacy overflow becomes unpinned without losing Local or remote paths', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-legacy-pins-'));
  roots.push(root);
  const pins = ['D:\\one', 'D:/one', ...Array.from({ length: 12 }, (_, index) => `/saved-${index}`)];
  const recents = Array.from({ length: 14 }, (_, index) => `/recent-${index}`);
  await writeFile(join(root, 'project-settings.json'), JSON.stringify({ paths: {
    pinnedProjectPaths: pins,
    recentProjectPaths: recents,
    byExecutor: { [EXECUTOR]: { pinnedPaths: pins, recentPaths: recents } },
  } }));
  const settings = new SettingsStore(root);
  await settings.init();
  const expectedPins = pins.slice(-5);
  const expectedRecents = [pins[0], ...pins.slice(2, -5), ...recents];
  const paths = settings.getPathSettings();
  expect(paths.pinnedProjectPaths).toEqual(expectedPins);
  expect(paths.recentProjectPaths).toEqual(expectedRecents);
  expect(paths.byExecutor?.[EXECUTOR]).toEqual({ pinnedPaths: expectedPins, recentPaths: expectedRecents });
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getPathSettings()).toEqual(paths);
});

test('executor-specific paths and recents survive restart without contaminating Local', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-executor-preferences-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  const selection = { agentId: 'test', model: 'synthetic-model' };
  await settings.recordChatStartup({ ...selection, projectPath: '/local ' });
  await settings.recordChatStartup({ ...selection, executorId: EXECUTOR, projectPath: '/remote ' });
  expect(settings.getRecentProjectPaths()).toEqual(['/local ']);
  expect(settings.getPathSettings().byExecutor).toEqual({ [EXECUTOR]: { recentPaths: ['/remote '], pinnedPaths: [] } });
  expect(settings.getRecentAgentSettings()).toHaveLength(2);
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getRecentProjectPaths()).toEqual(['/local ']);
  expect(restarted.getPathSettings().byExecutor?.[EXECUTOR]?.recentPaths).toEqual(['/remote ']);
  expect(restarted.getRecentAgentSettings()[0]?.executorId).toBe(EXECUTOR);
  expect(restarted.getRecentAgentSettings()[1]?.executorId).toBeUndefined();
  await restarted.forgetExecutor(EXECUTOR);
  expect(restarted.getRecentAgentSettings()).toHaveLength(1);
  expect(restarted.getPathSettings().byExecutor).toEqual({});
});

test('busy executor histories cannot evict other executors across recording, restart and deletion', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-executor-recents-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  for (let index = 0; index < 25; index += 1) {
    for (const executorId of ['local', EXECUTOR]) {
      await settings.recordChatStartup({ executorId, agentId: 'claude', model: `synthetic-${index}` });
    }
  }
  await settings.recordChatStartup({ agentId: 'claude', model: 'synthetic-10' });
  const expected = settings.getRecentAgentSettings();
  expect(expected).toHaveLength(40);
  expect(expected[0]?.model).toBe('synthetic-10');
  expect(expected[0]?.executorId).toBeUndefined();
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getRecentAgentSettings()).toEqual(expected);
  await restarted.forgetExecutor(EXECUTOR);
  expect(restarted.getRecentAgentSettings()).toEqual(expected.filter(entry => !entry.executorId));
  expect(restarted.getRecentAgentSettings()).toHaveLength(20);
});

test('all generation selections persist their explicit target and reject invalid identities', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-executor-generation-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  const selected = { executorId: EXECUTOR, agentId: 'test', model: 'synthetic-model' };
  await settings.setUiSettings(Object.fromEntries(GENERATION_UI_SETTING_KEYS.map((key) => [key, selected])));
  const restarted = new SettingsStore(root);
  await restarted.init();
  for (const key of GENERATION_UI_SETTING_KEYS) expect(restarted.getUiSettings()[key]).toEqual(selected);
  await expect(settings.setUiSettings({ chatTitle: { ...selected, executorId: 'invalid' } })).rejects.toThrow('Invalid executor ID');
  for (const key of GENERATION_UI_SETTING_KEYS) {
    await expect(settings.setUiSettings({ [key]: { executorId: EXECUTOR } })).rejects.toThrow('requires an agent and model');
  }
  expect(parseExecutorProjectPreferences({ local: { recentPaths: [], pinnedPaths: [] } })).toBeNull();
  expect(parseExecutorProjectPreferences({ [EXECUTOR]: { recentPaths: ['/remote'], pinnedPaths: [] } })).not.toBeNull();
  expect(() => resolveEffectiveGenerationConfig({
    persisted: { executorId: EXECUTOR }, authByAgent: {}, modelsByAgent: {}, generationByAgent: {},
  })).toThrow('requires an agent and model');
});

test.each([
  { executorId: 'not-a-executor', agentId: 'test', model: 'synthetic-model' },
  { executorId: 42, agentId: 'test', model: 'synthetic-model' },
  { executorId: '' },
  { executorId: EXECUTOR },
  { executorId: EXECUTOR, agentId: 'test' },
  { executorId: EXECUTOR, model: 'synthetic-model' },
])('unavailable stored generation selection stays readable without Local fallback: %j', async (selection) => {
  const root = await mkdtemp(join(homedir(), 'garcon-unavailable-generation-'));
  roots.push(root);
  const ui = Object.fromEntries(GENERATION_UI_SETTING_KEYS.map((key) => [key, selection]));
  await writeFile(join(root, 'project-settings.json'), JSON.stringify({
    ui: { ...ui, appIdentity: { title: 'Synthetic workspace' } }, pinnedChatIds: ['1767225600000000'],
  }));
  const settings = new SettingsStore(root);
  await settings.init();
  await settings.setUiSettings({ pinnedInsertPosition: 'bottom' });
  const agents = {
    getAgentAuthStatusMap: async () => ({ localagent: { authenticated: true } }),
    getAgentReadinessMap: async () => ({}),
    getAgentCatalogEntries: async () => [],
  } satisfies Pick<AgentRegistryServiceContract, 'getAgentAuthStatusMap' | 'getAgentReadinessMap' | 'getAgentCatalogEntries'>;
  const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, projectBasePath: '/project' });
  const parsed = normalizeRemoteSettingsSnapshot(snapshot);
  expect(parsed).not.toBeNull();
  expect(parsed?.pinnedChatIds).toEqual(['1767225600000000']);
  expect(parsed?.ui.appIdentity).toEqual({ title: 'Synthetic workspace' });
  const restarted = new SettingsStore(root);
  await restarted.init();
  for (const key of GENERATION_UI_SETTING_KEYS) {
    const expected = { ...selection, executorId: typeof selection.executorId === 'string' ? selection.executorId : '' };
    expect(parsed?.ui[key]).toEqual(expected);
    expect(parsed?.uiEffective[key]).toBeUndefined();
    expect(restarted.getUiSettings()[key]).toEqual(expected);
    expect(() => resolveEffectiveGenerationConfig({
      persisted: restarted.getUiSettings()[key], authByAgent: {}, modelsByAgent: {}, generationByAgent: {},
    })).toThrow();
  }
  expect((await readdir(root)).some((name) => name.includes('.corrupt'))).toBe(false);
});

test('executor path patches preserve concurrent recents and other executors through restart', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-executor-path-patch-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  const localPaths = { pinnedProjectPaths: ['/local/pin'], recentProjectPaths: ['/local/recent'], browseStartPath: '/local/default' };
  await settings.setPathSettings(localPaths);
  const otherExecutor = '33333333-3333-4333-8333-333333333333';
  await settings.recordChatStartup({ agentId: 'test', model: 'synthetic', executorId: EXECUTOR, projectPath: '/remote/old' });
  await settings.setPathSettings({ byExecutor: { [EXECUTOR]: { defaultPath: '/remote/default' } } });
  await Promise.all([
    settings.recordChatStartup({ agentId: 'test', model: 'synthetic', executorId: EXECUTOR, projectPath: '/remote/new' }),
    settings.setPathSettings({ byExecutor: { [otherExecutor]: { pinnedPaths: ['/other/pin'] } } }),
    settings.setPathSettings({ byExecutor: { [EXECUTOR]: { pinnedPaths: ['/remote/pin'] } } }),
  ]);
  const expected = {
    [EXECUTOR]: { defaultPath: '/remote/default', recentPaths: ['/remote/new', '/remote/old'], pinnedPaths: ['/remote/pin'] },
    [otherExecutor]: { recentPaths: [], pinnedPaths: ['/other/pin'] },
  };
  expect(settings.getPathSettings().byExecutor).toEqual(expected);
  await expect(settings.setPathSettings({ byExecutor: { [EXECUTOR]: { recentPaths: [] } } })).rejects.toThrow('Invalid executor project preferences');
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getPathSettings().byExecutor).toEqual(expected);
  expect(restarted.getPathSettings()).toEqual(expect.objectContaining(localPaths));
});

test.each(['local', EXECUTOR])('project removal serializes with newer pins and recents for %s', async (executorId) => {
  const root = await mkdtemp(join(homedir(), 'garcon-project-removal-'));
  roots.push(root);
  let holdNextWrite = false;
  let entered!: () => void;
  let release!: () => void;
  const writeEntered = new Promise<void>(resolve => { entered = resolve; });
  const writeReleased = new Promise<void>(resolve => { release = resolve; });
  const settings = new SettingsStore(root, { writeFile: async (...args) => {
    if (holdNextWrite) {
      holdNextWrite = false;
      entered();
      await writeReleased;
    }
    await writeJsonFileAtomic(...args);
  } });
  await settings.init();
  const selection = { agentId: 'test', model: 'synthetic', executorId };
  const otherExecutor = '33333333-3333-4333-8333-333333333333';
  const initialPins = ['D:\\projects\\atlas', '/keep'];
  const newPins = [...initialPins, '/new-pin'];
  await settings.setPathSettings({
    pinnedProjectPaths: executorId === 'local' ? initialPins : ['/local/pin'],
    recentProjectPaths: ['/local/recent'],
    browseStartPath: '/local/default',
    byExecutor: {
      ...(executorId === 'local' ? {} : { [executorId]: { defaultPath: '/remote/default', pinnedPaths: initialPins } }),
      [otherExecutor]: { defaultPath: '/other/default', pinnedPaths: ['D:/projects/atlas'] },
    },
  });
  await settings.recordChatStartup({ ...selection, projectPath: 'D:/projects/atlas' });
  holdNextWrite = true;
  const pinning = settings.setPathSettings(executorId === 'local'
    ? { pinnedProjectPaths: newPins }
    : { byExecutor: { [executorId]: { pinnedPaths: newPins } } });
  await writeEntered;
  const recording = settings.recordChatStartup({ ...selection, projectPath: '/new-recent' });
  const identity = { executorId, projectPath: 'D:/projects/atlas' };
  const removing = settings.removeProjectPathFromList(identity);
  identity.executorId = otherExecutor;
  identity.projectPath = '/unrelated';
  release();
  await Promise.all([pinning, recording, removing]);
  const paths = settings.getPathSettings();
  const owner = executorId === 'local'
    ? { pinnedPaths: paths.pinnedProjectPaths, recentPaths: paths.recentProjectPaths }
    : parseExecutorProjectPreferences(paths.byExecutor)?.[executorId];
  expect(owner?.pinnedPaths).toEqual(['/keep', '/new-pin']);
  expect(owner?.recentPaths).toEqual(executorId === 'local' ? ['/new-recent', '/local/recent'] : ['/new-recent']);
  expect(paths.browseStartPath).toBe('/local/default');
  expect(parseExecutorProjectPreferences(paths.byExecutor)?.[otherExecutor]).toEqual({
    defaultPath: '/other/default', pinnedPaths: ['D:/projects/atlas'], recentPaths: [],
  });
  if (executorId !== 'local') {
    expect(paths.pinnedProjectPaths).toEqual(['/local/pin']);
    expect(paths.recentProjectPaths).toEqual(['/local/recent']);
    expect(parseExecutorProjectPreferences(paths.byExecutor)?.[executorId]?.defaultPath).toBe('/remote/default');
  }
  const version = settings.getRemoteSettingsVersion();
  await settings.removeProjectPathFromList({ executorId, projectPath: 'D:\\projects\\atlas' });
  expect(settings.getRemoteSettingsVersion()).toBe(version);
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getPathSettings()).toEqual(paths);
});
