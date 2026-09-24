import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../store.js';
import { GENERATION_UI_SETTING_KEYS, normalizeRemoteSettingsSnapshot, parseNodeProjectPreferences } from '../../../common/settings.js';
import { resolveEffectiveGenerationConfig } from '../generation-effective.js';
import { buildRemoteSettingsSnapshot } from '../../routes/workspace.js';
import type { AgentRegistryServiceContract } from '../../agents/registry.js';

const NODE = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test('node-specific paths and recents survive restart without contaminating Local', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-node-preferences-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  const selection = { agentId: 'test', model: 'synthetic-model' };
  await settings.recordChatStartup({ ...selection, projectPath: '/local' });
  await settings.recordChatStartup({ ...selection, nodeId: NODE, projectPath: '/remote' });
  expect(settings.getRecentProjectPaths()).toEqual(['/local']);
  expect(settings.getPathSettings().byNode).toEqual({ [NODE]: { recentPaths: ['/remote'], pinnedPaths: [] } });
  expect(settings.getRecentAgentSettings()).toHaveLength(2);
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getRecentAgentSettings()[0]?.nodeId).toBe(NODE);
  expect(restarted.getRecentAgentSettings()[1]?.nodeId).toBeUndefined();
  await restarted.forgetExecutionNode(NODE);
  expect(restarted.getRecentAgentSettings()).toHaveLength(1);
  expect(restarted.getPathSettings().byNode).toEqual({});
});

test('all generation selections persist their explicit target and reject invalid identities', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-node-generation-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  const selected = { nodeId: NODE, agentId: 'test', model: 'synthetic-model' };
  await settings.setUiSettings(Object.fromEntries(GENERATION_UI_SETTING_KEYS.map((key) => [key, selected])));
  const restarted = new SettingsStore(root);
  await restarted.init();
  for (const key of GENERATION_UI_SETTING_KEYS) expect(restarted.getUiSettings()[key]).toEqual(selected);
  await expect(settings.setUiSettings({ chatTitle: { ...selected, nodeId: 'invalid' } })).rejects.toThrow('Invalid execution node ID');
  for (const key of GENERATION_UI_SETTING_KEYS) {
    await expect(settings.setUiSettings({ [key]: { nodeId: NODE } })).rejects.toThrow('requires an agent and model');
  }
  expect(parseNodeProjectPreferences({ local: { recentPaths: [], pinnedPaths: [] } })).toBeNull();
  expect(parseNodeProjectPreferences({ [NODE]: { recentPaths: ['/remote'], pinnedPaths: [] } })).not.toBeNull();
  expect(() => resolveEffectiveGenerationConfig({
    persisted: { nodeId: NODE }, authByAgent: {}, modelsByAgent: {}, generationByAgent: {},
  })).toThrow('requires an agent and model');
});

test.each([
  { nodeId: 'not-a-node', agentId: 'test', model: 'synthetic-model' },
  { nodeId: 42, agentId: 'test', model: 'synthetic-model' },
  { nodeId: '' },
  { nodeId: NODE },
  { nodeId: NODE, agentId: 'test' },
  { nodeId: NODE, model: 'synthetic-model' },
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
    const expected = { ...selection, nodeId: typeof selection.nodeId === 'string' ? selection.nodeId : '' };
    expect(parsed?.ui[key]).toEqual(expected);
    expect(parsed?.uiEffective[key]).toBeUndefined();
    expect(restarted.getUiSettings()[key]).toEqual(expected);
    expect(() => resolveEffectiveGenerationConfig({
      persisted: restarted.getUiSettings()[key], authByAgent: {}, modelsByAgent: {}, generationByAgent: {},
    })).toThrow();
  }
  expect((await readdir(root)).some((name) => name.includes('.corrupt'))).toBe(false);
});

test('node path patches preserve concurrent recents and other nodes through restart', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-node-path-patch-'));
  roots.push(root);
  const settings = new SettingsStore(root);
  await settings.init();
  const otherNode = '33333333-3333-4333-8333-333333333333';
  await settings.recordChatStartup({ agentId: 'test', model: 'synthetic', nodeId: NODE, projectPath: '/remote/old' });
  await settings.setPathSettings({ byNode: { [NODE]: { defaultPath: '/remote/default' } } });
  await Promise.all([
    settings.recordChatStartup({ agentId: 'test', model: 'synthetic', nodeId: NODE, projectPath: '/remote/new' }),
    settings.setPathSettings({ byNode: { [otherNode]: { pinnedPaths: ['/other/pin'] } } }),
    settings.setPathSettings({ byNode: { [NODE]: { pinnedPaths: ['/remote/pin'] } } }),
  ]);
  const expected = {
    [NODE]: { defaultPath: '/remote/default', recentPaths: ['/remote/new', '/remote/old'], pinnedPaths: ['/remote/pin'] },
    [otherNode]: { recentPaths: [], pinnedPaths: ['/other/pin'] },
  };
  expect(settings.getPathSettings().byNode).toEqual(expected);
  await expect(settings.setPathSettings({ byNode: { [NODE]: { recentPaths: [] } } })).rejects.toThrow('Invalid execution-node project preferences');
  const restarted = new SettingsStore(root);
  await restarted.init();
  expect(restarted.getPathSettings().byNode).toEqual(expected);
});
