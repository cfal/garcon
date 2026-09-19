import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../store.js';
import { GENERATION_UI_SETTING_KEYS, parseNodeProjectPreferences } from '../../../common/settings.js';
import { resolveEffectiveGenerationConfig } from '../generation-effective.js';

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
  expect(parseNodeProjectPreferences({ local: { recentPaths: [], pinnedPaths: [] } })).toBeNull();
  expect(parseNodeProjectPreferences({ [NODE]: { recentPaths: ['/remote'], pinnedPaths: [] } })).not.toBeNull();
  expect(() => resolveEffectiveGenerationConfig({
    persisted: { nodeId: NODE }, authByAgent: {}, modelsByAgent: {}, generationByAgent: {},
  })).toThrow('requires an agent and model');
});
