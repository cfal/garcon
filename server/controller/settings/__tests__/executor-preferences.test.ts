import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../store.js';
import { GENERATION_UI_SETTING_KEYS, normalizeRemoteSettingsSnapshot, parseExecutorProjectPreferences } from '../../../../common/settings.js';
import { resolveEffectiveGenerationConfig } from '../generation-effective.js';
import { buildRemoteSettingsSnapshot } from '../../routes/workspace.js';
import type { AgentRegistryServiceContract } from '../../agents/registry.js';

const EXECUTOR = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test('executor-specific paths and recents survive restart without contaminating Local', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-executor-preferences-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  const selection = { agentId: 'test', model: 'synthetic-model' };
  await settings.recordChatStartup({ ...selection, projectPath: '/local' });
  await settings.recordChatStartup({ ...selection, executorId: EXECUTOR, projectPath: '/remote' });
  expect(settings.getRecentProjectPaths()).toEqual(['/local']);
  expect(settings.getPathSettings().byExecutor).toEqual({ [EXECUTOR]: { recentPaths: ['/remote'], pinnedPaths: [] } });
  expect(settings.getRecentAgentSettings()).toHaveLength(2);
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getRecentAgentSettings()[0]?.executorId).toBe(EXECUTOR);
  expect(restarted.getRecentAgentSettings()[1]?.executorId).toBeUndefined();
  await restarted.forgetExecutor(EXECUTOR);
  expect(restarted.getRecentAgentSettings()).toHaveLength(1);
  expect(restarted.getPathSettings().byExecutor).toEqual({});
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
});
