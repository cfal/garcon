import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatRegistry } from '../store.ts';
import { ChatParentMutationService } from '../chat-parent-mutation-service.ts';
import { KeyedPromiseLock } from '../../../common/keyed-lock.ts';
import { withFailingDirectorySync } from '../../../common/__tests__/atomic-write-failure.ts';
import { isDirectDelegatedChild } from '../agent-delegation.ts';
import { AgentStopController } from '../agent-stop-controller.ts';

const [A, B, C, D, MISSING] = [0, 1, 2, 3, 4].map((n) => `178372590000020${n}`);
let directory;
let registry;
let service;
let lock;
let changed;

function add(id, parentChatId = null, lineage = null) {
  registry.addChat({ id, agentId: 'test', model: 'test', projectPath: '/project',
    preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId, lineage });
}
const set = (chatId, parentChatId) => service.set({ chatId, parentChatId });

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-parent-'));
  registry = new ChatRegistry(directory, { saveDelayMs: 60_000 });
  await registry.init();
  lock = new KeyedPromiseLock();
  service = new ChatParentMutationService({ registry, chatMutationLock: lock });
  changed = mock();
  registry.onChatParentUpdated(changed);
});

afterEach(async () => {
  await registry.flush();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('delegation parent mutation', () => {
  it.each([false, true])('changes controller stop admission after reparenting (remove=%s)', async (remove) => {
    add(A); add(B); add(C);
    const submit = mock(async () => {});
    const controller = new AgentStopController({
      registry, chatMutationLock: lock,
      notices: { existingCurrentView: () => ({ viewId: 'view' }), appendNotice: mock() },
      execution: { deliverServerControlInput: mock() },
      commands: { submitAgentCommandStopLocked: submit },
      isEnabled: () => true,
    });
    const request = async (chatId) => {
      controller.request({ chatId, viewId: 'view', runId: 'run', requestOrdinal: 0, at: '2030-01-01T00:00:00.000Z' },
        { type: 'stop-agent', chatId: A, remove });
      await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      await set(A, B);
      await request(B);
      await set(A, C);
      await request(B);
      await request(C);
      await set(A, null);
      await request(C);
      expect(submit.mock.calls.map(([input]) => input)).toEqual([
        { sourceChatId: B, sourceViewId: 'view', chatId: A, remove },
        { sourceChatId: C, sourceViewId: 'view', chatId: A, remove },
      ]);
    } finally { controller.shutdown(); }
  });

  it('attaches, replaces, clears and survives restart without changing other fields', async () => {
    add(A); add(B); add(C);
    const before = registry.getChat(A);
    expect(await set(A, B)).toMatchObject({ changed: true, parentChatId: B });
    expect(registry.getChat(A)).toEqual({ ...before, parentChatId: B });
    const restored = new ChatRegistry(directory);
    await restored.init();
    expect(restored.getChat(A).parentChatId).toEqual(B);
    expect(await set(A, C)).toMatchObject({ changed: true, parentChatId: C });
    expect(await set(A, null)).toMatchObject({ changed: true, parentChatId: null });
    expect(await set(A, null)).toMatchObject({ changed: false });
    expect(changed.mock.calls).toEqual([[A], [A], [A]]);
  });

  it('preserves generic patch protection and changes future delegated authority only', async () => {
    add(A); add(B); add(C);
    registry.updateChat(A, { parentChatId: B });
    expect(registry.getChat(A).parentChatId).toBeNull();
    await set(A, B);
    expect(isDirectDelegatedChild(B, A, registry.getChat(A))).toBe(true);
    await set(A, C);
    expect(isDirectDelegatedChild(B, A, registry.getChat(A))).toBe(false);
    expect(isDirectDelegatedChild(C, A, registry.getChat(A))).toBe(true);
    await set(A, null);
    expect(isDirectDelegatedChild(C, A, registry.getChat(A))).toBe(false);
  });

  it.each(['fork', 'handoff'])('preserves %s ancestry when replacing or clearing', async (relation) => {
    const lineage = { sourceChatId: B, kind: relation, transcriptViewId: 'synthetic-view', ordinal: 3 };
    add(A, null, lineage); add(B); add(C); add(D);
    expect(isDirectDelegatedChild(B, A, registry.getChat(A))).toBe(false);
    registry.updateChat(A, { lineage: null, parentChatId: B });
    expect(registry.getChat(A).lineage).toEqual(lineage);
    expect(registry.getChat(A).parentChatId).toBeNull();
    for (const parentChatId of [C, D, null]) {
      expect(await set(A, parentChatId)).toMatchObject({ changed: true, parentChatId });
      const restored = new ChatRegistry(directory);
      await restored.init();
      expect(restored.getChat(A).lineage).toEqual(lineage);
      expect(Object.isFrozen(restored.getChat(A).lineage)).toBe(true);
      expect(restored.getChat(A).parentChatId).toBe(parentChatId);
      expect(isDirectDelegatedChild(B, A, registry.getChat(A))).toBe(false);
      expect(isDirectDelegatedChild(D, A, registry.getChat(A))).toBe(parentChatId === D);
    }
    expect(changed.mock.calls).toEqual([[A], [A], [A]]);
  });

  it('handles missing chats and unchanged dangling parents', async () => {
    add(A, B);
    expect(await set(A, B)).toMatchObject({ changed: false });
    await expect(set(A, C)).rejects.toMatchObject({ code: 'PARENT_CHAT_NOT_FOUND' });
    await expect(set(MISSING, A)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(await set(A, null)).toMatchObject({ changed: true });
  });

  it('rejects delegation cycles but permits mixed lineage/delegation loops', async () => {
    add(A); add(B, null, { sourceChatId: A, kind: 'fork', transcriptViewId: 'view', ordinal: 0 });
    add(C, D); add(D, C);
    for (const parent of [A, C]) {
      await expect(set(A, parent)).rejects.toMatchObject({ code: 'CHAT_PARENT_CYCLE' });
    }
    expect(await set(A, B)).toMatchObject({ changed: true, parentChatId: B });
    await expect(set(B, A)).rejects.toMatchObject({ code: 'CHAT_PARENT_CYCLE' });
    await set(C, null);
    await set(A, D);
    expect(registry.getChat(A).parentChatId).toEqual(D);
  });

  it('allows ancestry ending at a missing higher parent', async () => {
    add(A); add(B, MISSING);
    expect(await set(A, B)).toMatchObject({ changed: true });
  });

  it('serializes disjoint endpoint writes before checking longer cycles', async () => {
    add(A); add(B, C); add(C); add(D, A);
    await registry.flush();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const rename = fs.rename;
    const held = spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return rename(...args);
    });
    try {
      const first = set(A, B);
      await entered.promise;
      const second = set(C, D).catch((error) => error);
      release.resolve();
      expect(await first).toMatchObject({ changed: true });
      expect(await second).toMatchObject({ code: 'CHAT_PARENT_CYCLE' });
    } finally { release.resolve(); held.mockRestore(); }
    expect(registry.getChat(C).parentChatId).toBeNull();
  });

  it('re-reads parent existence after acquiring the shared mutation locks', async () => {
    add(A); add(B);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const deletion = lock.runExclusive(`chat:${B}`, async () => {
      entered.resolve();
      await release.promise;
      registry.removeChat(B);
    });
    await entered.promise;
    const pending = set(A, B).catch((error) => error);
    release.resolve();
    await deletion;
    expect(await pending).toMatchObject({ code: 'PARENT_CHAT_NOT_FOUND' });
  });

  it('leaves the old projection on pre-rename failure', async () => {
    add(A); add(B);
    await registry.flush();
    const failure = spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic write failure'));
    try { await expect(set(A, B)).rejects.toMatchObject({ code: 'CHAT_PARENT_SAVE_FAILED' }); }
    finally { failure.mockRestore(); }
    expect(registry.getChat(A).parentChatId).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it('publishes retained uncertain writes and reconciles before an explicit subsequent setter', async () => {
    add(A); add(B); add(C);
    await registry.flush();
    await withFailingDirectorySync(directory, async () => {
      await expect(set(A, B)).rejects.toMatchObject({ code: 'CHAT_PARENT_SAVE_UNKNOWN' });
      expect(registry.getChat(A).parentChatId).toEqual(B);
      await expect(set(A, C)).rejects.toMatchObject({ code: 'CHAT_PARENT_SAVE_UNKNOWN' });
      expect(registry.getChat(A).parentChatId).toEqual(B);
    });
    expect(changed.mock.calls).toEqual([[A]]);
    expect(await set(A, B)).toMatchObject({ changed: false });
    expect(await set(A, C)).toMatchObject({ changed: true });
  });
});
