import { afterEach, expect, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ApiProviderStore } from '../store.js';
import { ChatRegistry } from '../../chats/store.js';
import { AgentOwnershipJournal } from '../../chats/agent-ownership-journal.js';
import { SettingsStore } from '../../settings/store.js';
import { ScheduledPromptStore } from '../../scheduled-prompts/store.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const chatId = '1767225600000000';
const timestamp = '2026-01-01T00:00:00.000Z';
const kinds = ['settings', 'schedule', 'handoff', 'chat'] as const;
type Kind = typeof kinds[number];
const filenames: Record<Kind, string> = { settings: 'project-settings.json', schedule: 'scheduled-prompts.json', handoff: 'agent-ownership-journal.json', chat: 'chats.json' };

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'provider-reference-publication-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApiProviderStore(join(root, 'api-providers.json'));
  await store.init();
  const provider = await store.createApiProvider({ templateId: 'custom', label: 'Synthetic', protocol: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1', defaultModel: 'synthetic-model', models: [], supportsImages: false, modelDiscovery: 'none' });
  const retainProviderReferences = store.referenceWrites.retain;
  const chats = new ChatRegistry(root, { retainProviderReferences, saveDelayMs: 60_000 });
  const settings = new SettingsStore(root, { retainProviderReferences });
  const schedules = new ScheduledPromptStore(root, undefined, retainProviderReferences);
  await chats.init();
  await settings.init();
  await schedules.init();
  cleanup.push(() => chats.flush());
  chats.addChat({ id: chatId, agentId: 'test', model: 'synthetic-model', projectPath: root, parentChat: null });
  await chats.flush();
  const ownership = new AgentOwnershipJournal({ workspaceDir: root, registry: chats, retainProviderReferences,
    integrations: { get: () => null, require: () => { throw new Error('No integration needed'); } }, ledger: { deleteChat: () => {} } });
  await ownership.initialize();
  const selection = { agentId: 'test', model: 'synthetic-model', projectPath: root, apiProviderId: provider.id,
    modelEndpointId: provider.endpoints[0]!.id, modelProtocol: 'openai-compatible' as const,
    permissionMode: 'default' as const, thinkingMode: 'none' as const };
  const publish = (kind: Kind): Promise<unknown> => {
    switch (kind) {
      case 'settings': return settings.setUiSettings({ promptRefinement: selection });
      case 'schedule': return schedules.create({ id: '33333333-3333-4333-8333-333333333333', prompt: 'Synthetic prompt',
        schedule: { type: 'once', nextRunAt: '2099-01-01T00:00:00.000Z' },
        target: { type: 'new-chat', ...selection, agentSettingsById: {}, tags: [], preambleChoice: { mode: 'defaults' } },
        createdAt: timestamp, updatedAt: timestamp }, schedules.revision);
      case 'handoff': return ownership.decideHandoff({ operationId: 'synthetic-operation', clientRequestId: 'synthetic-request',
        submittedTargetHash: 'a'.repeat(64), chatId, source: chats.getChat(chatId)!, targetAgentOwnershipEpoch: 'synthetic-destination',
        watermark: { viewId: 'synthetic-view', ordinal: 0 }, target: { ...selection, nodeId: 'local', agentSettings: { ownerId: 'test', schemaVersion: 1, values: {} } } });
      case 'chat': return chats.updateChatPhased(chatId, { apiProviderId: provider.id, modelEndpointId: selection.modelEndpointId, modelProtocol: selection.modelProtocol });
    }
  };
  const remove = () => store.deleteApiProvider(provider.id, (id) => [chats, settings, schedules, ownership].some((owner) => owner.referencesApiProvider(id)));
  return { root, store, provider, chats, schedules, settings, ownership, publish, remove };
}

function gateRename(filename: string, failure?: Error) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rename = fs.rename;
  const spy = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (basename(String(target)) === filename) {
      entered.resolve();
      await release.promise;
      if (failure) throw failure;
    }
    await rename(source, target);
  });
  cleanup.push(async () => { release.resolve(); spy.mockRestore(); });
  return { entered: entered.promise, release: () => release.resolve(), restore: () => spy.mockRestore() };
}

test.each(kinds)('profile deletion rejects pending and committed %s references', async (kind) => {
  const { publish, remove } = await fixture();
  const gate = gateRename(filenames[kind]);
  const writing = publish(kind);
  await gate.entered;
  await expect(remove()).rejects.toMatchObject({ code: 'API_PROVIDER_IN_USE' });
  gate.release();
  await writing;
  await expect(remove()).rejects.toMatchObject({ code: 'API_PROVIDER_IN_USE' });
});

test.each(kinds)('deletion fences a new %s reference before it becomes durable', async (kind) => {
  const { publish, remove } = await fixture();
  const gate = gateRename('api-providers.json');
  const deleting = remove();
  await gate.entered;
  await expect(publish(kind)).rejects.toMatchObject({ code: 'API_PROVIDER_UNAVAILABLE' });
  gate.release();
  await deleting;
});

test.each(kinds)('a rejected %s publication releases its reservation', async (kind) => {
  const { publish, remove } = await fixture();
  const gate = gateRename(filenames[kind], new Error('Synthetic failure'));
  const writing = publish(kind).catch((error: unknown) => error);
  await gate.entered;
  gate.release();
  expect(await writing).toBeInstanceOf(Error);
  gate.restore();
  await remove();
});

test.each(kinds)('an uncertain %s publication retains possible durable references', async (kind) => {
  const { root, publish, remove } = await fixture();
  const open = fs.open;
  const failure = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    if (path === root && flags === 'r') throw new Error('Synthetic directory sync failure');
    return open(path, flags, mode);
  });
  try {
    if (kind === 'chat') expect(await publish(kind)).toMatchObject({ durability: 'unknown' });
    else await expect(publish(kind)).rejects.toBeInstanceOf(Error);
  } finally { failure.mockRestore(); }
  await expect(remove()).rejects.toMatchObject({ code: 'API_PROVIDER_IN_USE' });
});

test.each(['confirmed', 'failed', 'uncertain'] as const)('removing the last chat reference retains disk protection until confirmed (%s)', async (outcome) => {
  const { root, publish, remove, chats } = await fixture();
  await publish('chat');
  chats.removeChat(chatId, 'start-compensation');
  await expect(remove()).rejects.toMatchObject({ code: 'API_PROVIDER_IN_USE' });
  const gate = gateRename('chats.json', outcome === 'failed' ? new Error('Synthetic failure') : undefined);
  const open = fs.open;
  const failure = spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    if (outcome === 'uncertain' && path === root && flags === 'r') throw new Error('Synthetic sync failure');
    return open(path, flags, mode);
  });
  try {
    const writing = chats.flush().catch((error: unknown) => error);
    await gate.entered;
    gate.release();
    expect(await writing).toEqual(outcome === 'confirmed' ? undefined : expect.any(Error));
  } finally { gate.restore(); failure.mockRestore(); }
  if (outcome !== 'confirmed') {
    await expect(remove()).rejects.toMatchObject({ code: 'API_PROVIDER_IN_USE' });
    await chats.flush();
  }
  await remove();
});

test('unknown historical provider references can be retained and removed without reauthorization', async () => {
  const { root, store, provider, chats, settings } = await fixture();
  await settings.setUiSettings({ chatTitle: { apiProviderId: provider.id, modelEndpointId: provider.endpoints[0]!.id, agentId: 'test', model: 'synthetic-model' } });
  await store.deleteApiProvider(provider.id, () => false);
  await settings.setUiSettings({ promptRefinement: {} });
  await settings.setUiSettings({ chatTitle: {} });
  expect(settings.referencesApiProvider(provider.id)).toBe(false);
  expect(store.getApiProvider(provider.id)).toBeNull();
  expect(() => chats.addChat({ id: '1767225600000001', agentId: 'test', model: 'synthetic-model', projectPath: root, parentChat: null, apiProviderId: provider.id })).toThrow('unavailable');
});
