import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AUTOMATION_PRESENTATION, CONVERSATION_PRESENTATION, GUARDED_AUTOMATION_POLICY } from '../../../../common/automation.js';
import { parsePromoteChatResponse } from '../../../../common/chat-presentation-contracts.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { ChatRegistry } from '../../chats/store.js';
import { ChatListProjector } from '../../chats/chat-list-projector.js';
import { createChatPresentationRoutes } from '../chat-presentation.js';

const CHAT_ID = '1783725900000800';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(group: 'orphan' | 'pinned' | 'normal' | 'archived' = 'orphan') {
  const base = join(homedir(), 'tmp');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'garcon-presentation-'));
  directories.push(directory);
  const registry = new ChatRegistry(directory);
  await registry.init();
  registry.addChat({ id: CHAT_ID, agentId: 'test', projectPath: '/repo', model: 'test', parentChat: null,
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
    presentation: AUTOMATION_PRESENTATION, automationPolicy: GUARDED_AUTOMATION_POLICY });
  await registry.flush();
  const existingOrder = ['1783725900000801', CHAT_ID];
  let normal: string[] = group === 'normal' ? existingOrder : [];
  let failOrder = false;
  const listChanges: [string, string][] = [];
  const settings = {
    getPinnedChatIds: () => group === 'pinned' ? existingOrder : [], getNormalChatIds: () => normal,
    getArchivedChatIds: () => group === 'archived' ? existingOrder : [], getChatName: () => 'Synthetic worker',
    emitListChanged: (reason: string, id: string) => { listChanges.push([reason, id]); },
    async ensureInNormal(id: string) {
      const reopened = new ChatRegistry(directory);
      await reopened.init();
      expect(reopened.getChat(id)?.presentation).toEqual(CONVERSATION_PRESENTATION);
      if (failOrder) throw new Error('Synthetic order failure');
      normal = [id];
    },
  };
  const projector = new ChatListProjector({ registry, settings,
    metadata: { listAllChatMetadata: () => new Map(), getChatMetadata: () => null },
    processing: { phase: () => null }, canReloadFromNativeHistory: () => false });
  const lock = new KeyedPromiseLock();
  const routes = createChatPresentationRoutes({ registry, settings, chatMutationLock: lock, chatListProjector: projector });
  const promote = (body: unknown = { chatId: CHAT_ID }) => {
    const url = new URL('http://localhost/api/v1/chats/promote');
    return routes[url.pathname]!.POST!(new Request(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), url);
  };
  return { registry, promote, lock, settings, listChanges, setFailOrder: (value: boolean) => { failOrder = value; } };
}

test('promotion durably restores normal presentation before list publication, preserving containment', async () => {
  const { registry, promote } = await fixture();
  const response = await promote();
  expect(response.status).toBe(200);
  const result = parsePromoteChatResponse(await response.json());
  expect(result?.chat.presentation).toEqual(CONVERSATION_PRESENTATION);
  expect(result?.chat.orderGroup).toBe('normal');
  expect(registry.getChat(CHAT_ID)?.automationPolicy).toEqual(GUARDED_AUTOMATION_POLICY);
  expect((await promote()).status).toBe(200);
});

test('promotion rejects forged policy and missing chats without creating them', async () => {
  const { registry, promote } = await fixture();
  expect((await promote({ chatId: CHAT_ID, automationPolicy: {} })).status).toBe(400);
  expect(registry.getChat(CHAT_ID)?.presentation).toEqual(AUTOMATION_PRESENTATION);
  expect((await promote({ chatId: '1783725900000801' })).status).toBe(404);
});

test.each(['pinned', 'normal', 'archived'] as const)('promotion preserves %s placement across retries', async group => {
  const { promote, settings, listChanges } = await fixture(group);
  const order = () => [settings.getPinnedChatIds(), settings.getNormalChatIds(), settings.getArchivedChatIds()];
  const before = structuredClone(order());
  for (let retry = 0; retry < 2; retry++) {
    const response = await promote();
    expect(response.status).toBe(200);
    expect(parsePromoteChatResponse(await response.json())?.chat.orderGroup).toBe(group);
    expect(order()).toEqual(before);
  }
  expect(listChanges).toEqual(Array(2).fill(['chat-presentation-changed', CHAT_ID]));
});

test('an explicit retry completes promotion after an order-write failure', async () => {
  const { registry, promote, setFailOrder } = await fixture();
  setFailOrder(true);
  expect((await promote()).status).toBe(500);
  expect(registry.getChat(CHAT_ID)?.automationPolicy).toEqual(GUARDED_AUTOMATION_POLICY);
  setFailOrder(false);
  expect((await promote()).status).toBe(200);
});

test('promotion serializes with chat mutations', async () => {
  const { registry, promote, lock } = await fixture();
  const released = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const blocking = lock.runExclusive(`chat:${CHAT_ID}`, async () => { held.resolve(); await released.promise; });
  await held.promise;
  const pending = promote();
  await new Promise(resolve => setImmediate(resolve));
  expect(registry.getChat(CHAT_ID)?.presentation).toEqual(AUTOMATION_PRESENTATION);
  released.resolve();
  await blocking;
  expect((await pending).status).toBe(200);
});
