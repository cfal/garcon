import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatRegistry } from '../store.ts';

const CHAT_ID = '1783725900000200';
const SECOND_CHAT_ID = '1783725900000201';
const PREAMBLE_ID = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const envelope = (ownerId, values = {}) => ({ ownerId, schemaVersion: 1, values });
const nativeSession = (ownerId, value = { path: '/tmp/native.jsonl' }) => ({
  ownerId,
  schemaVersion: 1,
  value,
});

let tempDir;
let registry;

function newChat(overrides = {}) {
  return {
    id: CHAT_ID,
    agentId: 'test',
    model: 'model-a',
    projectPath: '/repo',
    agentSettingsById: { test: envelope('test') },
    parentChat: null,
    ...overrides,
  };
}

function persistedEntry(overrides = {}) {
  return {
    agentId: 'test',
    agentSessionId: 'native-1',
    nativeSession: nativeSession('test'),
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: { test: envelope('test') },
    projectPath: '/repo',
    tags: [],
    model: 'model-a',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    lastReadAt: null,
    permissionMode: 'default',
    thinkingMode: 'none',
    carryOverSegments: [],
    nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null,
    pendingPreambleBoundary: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] },
    parentChat: null,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function writeRegistry(sessions, version = 5) {
  await fs.writeFile(path.join(tempDir, 'chats.json'), JSON.stringify({ version, sessions }));
}

describe('ChatRegistry phased updates', () => {
  const SELECTION_ID = '3502b645-222b-49d2-ac39-1c91f9fb1174';

  it('rolls a rejected selection patch back even after an unrelated concurrent mutation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chats-phased-'));
    const registry = new ChatRegistry(tempDir);
    await registry.init();
    registry.addChat({
      id: CHAT_ID,
      agentId: 'test',
      model: 'model-a',
      projectPath: '/repo',
      agentSettingsById: { test: envelope('test') },
      preambleSelection: { revision: 0, orderedPreambleIds: [] },
      pendingPreambleBoundary: null,
      parentChat: null,
    });
    const epoch = registry.getChat(CHAT_ID).agentOwnershipEpoch;

    // Fail the atomic write before rename only for the phased flush.
    const originalRename = fs.rename;
    let failNextWrite = false;
    fs.rename = async (source, target) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('disk full');
      }
      return originalRename(source, target);
    };
    try {
      failNextWrite = true;
      const phased = registry.updateChatPhased(CHAT_ID, {
        preambleSelection: { revision: 1, orderedPreambleIds: [SELECTION_ID] },
        pendingPreambleBoundary: {
          kind: 'selection-change',
          ownershipEpoch: epoch,
          selectionRevision: 1,
        },
      }).catch((error) => error);
      // An unrelated same-chat mutation lands while persistence is failing;
      // it must survive the rejected selection's rollback.
      await new Promise((resolve) => setTimeout(resolve, 5));
      registry.updateChat(CHAT_ID, { agentSessionId: 'native-concurrent' });
      await expect(phased).resolves.toMatchObject({ message: expect.stringContaining('disk full') });
    } finally {
      fs.rename = originalRename;
    }

    const entry = registry.getChat(CHAT_ID);
    expect(entry.preambleSelection).toEqual({ revision: 0, orderedPreambleIds: [] });
    expect(entry.pendingPreambleBoundary).toBeNull();
    expect(entry.agentSessionId).toBe('native-concurrent');

    // The rejected selection must not survive into the next persisted flush.
    await registry.flush();
    const reloaded = new ChatRegistry(tempDir);
    await reloaded.init();
    expect(reloaded.getChat(CHAT_ID).preambleSelection).toEqual({
      revision: 0,
      orderedPreambleIds: [],
    });
    expect(reloaded.getChat(CHAT_ID).agentSessionId).toBe('native-concurrent');
    await reloaded.flush();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

describe('ChatRegistry', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-registry-'));
    registry = new ChatRegistry(tempDir);
    await registry.init();
  });

  afterEach(async () => {
    await registry?.flush().catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('hands out deep copies that cannot mutate registry state', () => {
    registry.addChat(newChat({
      tags: ['source'],
      agentSettingsById: { test: envelope('test') },
      agentOwnershipEpoch: 'epoch-1',
      pendingPreambleBoundary: { kind: 'new-chat', ownershipEpoch: 'epoch-1' },
    }));

    const chat = registry.getChat(CHAT_ID);
    chat.tags.push('injected');
    chat.agentSettingsById.test.values.injected = true;
    chat.pendingPreambleBoundary.ownershipEpoch = 'injected';

    const updated = registry.updateChat(CHAT_ID, { model: 'other-model' });
    updated.tags.push('via-update');
    updated.agentSettingsById.test.values.injected = true;
    updated.pendingPreambleBoundary.ownershipEpoch = 'injected';

    expect(registry.getChat(CHAT_ID).tags).toEqual(['source']);
    expect(registry.getChat(CHAT_ID).agentSettingsById.test.values).toEqual({});
    expect(registry.getChat(CHAT_ID).pendingPreambleBoundary).toEqual({
      kind: 'new-chat',
      ownershipEpoch: 'epoch-1',
    });
  });

  it('clones caller-owned collections on ingest', () => {
    const tags = ['source'];
    const agentSettingsById = { test: envelope('test') };
    const session = nativeSession('test');
    registry.addChat(newChat({ tags, agentSettingsById, nativeSession: session }));

    tags.push('injected');
    agentSettingsById.test.values.injected = true;
    session.value.injected = true;
    expect(registry.getChat(CHAT_ID).nativeSession.value).toEqual({ path: '/tmp/native.jsonl' });

    const updateTags = ['via-update'];
    const updateSettings = { test: envelope('test') };
    const updateSession = nativeSession('test', { path: '/tmp/next.jsonl' });
    registry.updateChat(CHAT_ID, {
      tags: updateTags,
      agentSettingsById: updateSettings,
      nativeSession: updateSession,
    });
    updateTags.push('injected');
    updateSettings.test.values.injected = true;
    updateSession.value.injected = true;

    expect(registry.getChat(CHAT_ID).tags).toEqual(['via-update']);
    expect(registry.getChat(CHAT_ID).agentSettingsById.test.values).toEqual({});
    expect(registry.getChat(CHAT_ID).nativeSession.value).toEqual({ path: '/tmp/next.jsonl' });
  });

  it('adds provider-neutral records with opaque ownership defaults', () => {
    const added = mock(() => undefined);
    registry.onChatAdded(added);

    expect(registry.addChat(newChat({ permissionMode: 'invalid', thinkingMode: 'invalid' }))).toBe(true);

    expect(registry.getChat(CHAT_ID)).toMatchObject({
      agentId: 'test',
      agentSessionId: null,
      nativeSession: null,
      agentOwnershipEpoch: expect.any(String),
      agentSettingsById: { test: envelope('test') },
      permissionMode: 'default',
      thinkingMode: 'none',
      nextForkOrdinal: 1,
      parentChat: null,
    });
    expect(added).toHaveBeenCalledWith(CHAT_ID);
  });

  it('rejects duplicate IDs and native sessions owned by another integration', () => {
    registry.addChat(newChat());
    expect(() => registry.addChat(newChat())).toThrow('already exists');
    expect(() => registry.addChat(newChat({
      id: SECOND_CHAT_ID,
      nativeSession: nativeSession('other'),
    }))).toThrow('Native session owner mismatch');
  });

  it('persists and freezes immutable parentage', async () => {
    const parentChat = {
      chatId: CHAT_ID,
      relation: 'fork',
      transcriptViewId: 'view-a',
      ordinal: 0,
    };
    registry.addChat(newChat({
      id: SECOND_CHAT_ID,
      parentChat,
    }));

    const child = registry.getChat(SECOND_CHAT_ID);
    expect(child.parentChat).toEqual(parentChat);
    expect(Object.isFrozen(child.parentChat)).toBeTrue();

    await registry.flush();
    registry = new ChatRegistry(tempDir);
    await registry.init();
    expect(registry.getChat(SECOND_CHAT_ID)?.parentChat).toEqual(parentChat);
  });

  it('keeps the registry owner-only after saving', async () => {
    registry.addChat(newChat());
    await registry.flush();

    const stats = await fs.stat(path.join(tempDir, 'chats.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('repairs permissions on an existing registry during init', async () => {
    if (process.platform === 'win32') return;
    const registryPath = path.join(tempDir, 'chats.json');
    await fs.writeFile(registryPath, JSON.stringify({ version: 5, sessions: {} }), { mode: 0o644 });

    registry = new ChatRegistry(tempDir);
    await registry.init();

    expect((await fs.stat(registryPath)).mode & 0o777).toBe(0o600);
  });

  it('loads an existing registry when permission repair fails', async () => {
    if (process.platform === 'win32') return;
    const registryPath = path.join(tempDir, 'chats.json');
    await fs.writeFile(registryPath, JSON.stringify({ version: 5, sessions: {} }), { mode: 0o644 });
    const chmod = spyOn(fs, 'chmod').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EPERM' }));
    try {
      registry = new ChatRegistry(tempDir);
      await expect(registry.init()).resolves.toEqual({ version: 5, sessions: {} });
    } finally {
      chmod.mockRestore();
    }
  });

  it('persists and freezes watermark-free delegation parentage', async () => {
    const parentChat = { chatId: CHAT_ID, relation: 'delegation' };
    registry.addChat(newChat({ id: SECOND_CHAT_ID, parentChat }));

    const child = registry.getChat(SECOND_CHAT_ID);
    expect(child.parentChat).toEqual(parentChat);
    expect(Object.isFrozen(child.parentChat)).toBeTrue();

    await registry.flush();
    registry = new ChatRegistry(tempDir);
    await registry.init();
    expect(registry.getChat(SECOND_CHAT_ID)?.parentChat).toEqual(parentChat);
  });

  it('rejects malformed and self-referential new parentage', () => {
    expect(() => registry.addChat(newChat({ parentChat: undefined }))).toThrow(
      'Invalid parent chat',
    );
    expect(() => registry.addChat(newChat({
      parentChat: {
        chatId: CHAT_ID,
        relation: 'fork',
        transcriptViewId: 'view-a',
        ordinal: 1,
      },
    }))).toThrow('cannot be its own parent');
    expect(() => registry.addChat(newChat({
      parentChat: { chatId: CHAT_ID, relation: 'delegation' },
    }))).toThrow('cannot be its own parent');
    expect(registry.listAllChats()).toEqual({});
  });

  it('patches only allowed fields and keeps the session ID index current', () => {
    registry.addChat(newChat({ agentSessionId: 'native-1' }));

    const updated = registry.updateChat(CHAT_ID, {
      model: 'model-b',
      agentSessionId: 'native-2',
      projectPath: '/ignored',
    });

    expect(updated).toMatchObject({ model: 'model-b', projectPath: '/repo' });
    expect(registry.getChatByAgentSessionId('native-1')).toBeNull();
    expect(registry.getChatByAgentSessionId('native-2')?.[0]).toBe(CHAT_ID);
  });

  it('reports existence for own keys only', () => {
    registry.addChat(newChat());

    expect(registry.hasChat(CHAT_ID)).toBe(true);
    expect(registry.hasChat(SECOND_CHAT_ID)).toBe(false);
    // sessions is a plain object, so inherited keys like "toString" must not
    // register as chats.
    expect(registry.hasChat('toString')).toBe(false);
    expect(registry.hasChat('__proto__')).toBe(false);
  });

  it('returns null instead of prototype entries for unknown lookups', () => {
    registry.addChat(newChat());

    expect(registry.getChat('toString')).toBeNull();
    expect(registry.getChat('__proto__')).toBeNull();
    expect(registry.getChat(SECOND_CHAT_ID)).toBeNull();
  });

  it('ignores untyped parentage patches', () => {
    registry.addChat(newChat());

    registry.updateChat(CHAT_ID, {
      parentChat: {
        chatId: SECOND_CHAT_ID,
        relation: 'handoff',
        transcriptViewId: 'view-b',
        ordinal: 2,
      },
    });

    expect(registry.getChat(CHAT_ID)?.parentChat).toBeNull();
  });

  it('adds normalized tags without removing existing tags', () => {
    registry.addChat(newChat({
      tags: ['existing'],
      preambleSelection: { revision: 1, orderedPreambleIds: [PREAMBLE_ID] },
    }));
    const updated = [];
    registry.onChatTagsUpdated((chatId) => updated.push(chatId));

    const changed = registry.addTags(CHAT_ID, ['CLI', 'existing', 'Review Needed']);
    expect(changed).toMatchObject({
      tags: ['cli', 'existing', 'review-needed'],
    });
    changed.preambleSelection.orderedPreambleIds.length = 0;
    const unchanged = registry.addTags(CHAT_ID, ['cli']);
    expect(unchanged).toMatchObject({
      tags: ['cli', 'existing', 'review-needed'],
    });
    unchanged.preambleSelection.orderedPreambleIds.length = 0;
    expect(registry.getChat(CHAT_ID).preambleSelection.orderedPreambleIds).toEqual([PREAMBLE_ID]);
    expect(updated).toEqual([CHAT_ID]);
  });

  it('validates owner-bound settings patches', () => {
    registry.addChat(newChat());
    expect(() => registry.updateChat(CHAT_ID, {
      agentSettingsById: { test: { ownerId: 'other', schemaVersion: 1, values: {} } },
    })).toThrow('Invalid agent settings');
  });

  it('flushes opaque session binding patches immediately', async () => {
    registry.addChat(newChat());
    await registry.updateChat(CHAT_ID, {
      agentSessionId: 'native-1',
      nativeSession: nativeSession('test', { id: 'native-1' }),
    }, { flush: true });

    const persisted = JSON.parse(await fs.readFile(path.join(tempDir, 'chats.json'), 'utf8'));
    expect(persisted.version).toBe(5);
    expect(persisted.sessions[CHAT_ID]).toMatchObject({
      agentSessionId: 'native-1',
      nativeSession: nativeSession('test', { id: 'native-1' }),
    });
    expect(persisted.sessions[CHAT_ID].nativePath).toBeUndefined();
  });

  it('persists overlapping registry saves in invocation order', async () => {
    registry.addChat(newChat());
    const firstRenameEntered = deferred();
    const releaseFirstRename = deferred();
    const originalRename = fs.rename.bind(fs);
    let heldFirstRename = false;
    const rename = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (!heldFirstRename && target === path.join(tempDir, 'chats.json')) {
        heldFirstRename = true;
        firstRenameEntered.resolve();
        await releaseFirstRename.promise;
      }
      return originalRename(source, target);
    });

    try {
      const olderSave = registry.flush();
      await firstRenameEntered.promise;
      registry.updateChat(CHAT_ID, { model: 'model-b' });
      const newerSave = registry.flush();
      releaseFirstRename.resolve();
      await Promise.all([olderSave, newerSave]);
    } finally {
      releaseFirstRename.resolve();
      rename.mockRestore();
    }

    registry = new ChatRegistry(tempDir);
    await registry.init();
    expect(registry.getChat(CHAT_ID)?.model).toBe('model-b');
  });

  it('restores immediate patches and defers events when persistence fails', async () => {
    registry.addChat(newChat({ agentSessionId: 'native-1', tags: ['source'] }));
    await registry.updateChat(CHAT_ID, {
      lastReadAt: '2026-08-09T09:00:00.000Z',
    }, { flush: true });
    const readUpdated = mock(() => undefined);
    const tagsUpdated = mock(() => undefined);
    registry.onChatReadUpdated(readUpdated);
    registry.onChatTagsUpdated(tagsUpdated);
    const saveRegistry = registry.saveRegistry.bind(registry);
    registry.saveRegistry = mock(() => Promise.reject(new Error('disk full')));

    await expect(registry.updateChat(CHAT_ID, {
      agentSessionId: 'native-2',
      tags: ['target'],
      lastReadAt: '2026-08-09T10:00:00.000Z',
    }, { flush: true })).rejects.toThrow('disk full');

    expect(registry.getChat(CHAT_ID)).toMatchObject({
      agentSessionId: 'native-1',
      tags: ['source'],
      lastReadAt: '2026-08-09T09:00:00.000Z',
    });
    expect(registry.getChatByAgentSessionId('native-1')?.[0]).toBe(CHAT_ID);
    expect(registry.getChatByAgentSessionId('native-2')).toBeNull();
    expect(readUpdated).not.toHaveBeenCalled();
    expect(tagsUpdated).not.toHaveBeenCalled();

    registry.saveRegistry = saveRegistry;
    await registry.flush();
    registry = new ChatRegistry(tempDir);
    await registry.init();
    expect(registry.getChat(CHAT_ID)).toMatchObject({
      agentSessionId: 'native-1',
      tags: ['source'],
      lastReadAt: '2026-08-09T09:00:00.000Z',
    });
    expect(registry.getChatByAgentSessionId('native-1')?.[0]).toBe(CHAT_ID);
    expect(registry.getChatByAgentSessionId('native-2')).toBeNull();
  });

  it('does not roll back a newer patch when an earlier save fails', async () => {
    registry.addChat(newChat());
    await registry.flush();
    const firstSaveEntered = deferred();
    const releaseFirstSave = deferred();
    const saveRegistry = registry.saveRegistry.bind(registry);
    let saveCount = 0;
    registry.saveRegistry = mock(async () => {
      saveCount += 1;
      if (saveCount !== 1) return;
      firstSaveEntered.resolve();
      await releaseFirstSave.promise;
      throw new Error('disk full');
    });

    try {
      const olderUpdate = registry.updateChat(
        CHAT_ID,
        { model: 'model-b' },
        { flush: true },
      );
      await firstSaveEntered.promise;
      await registry.updateChat(CHAT_ID, { model: 'model-c' }, { flush: true });
      releaseFirstSave.resolve();
      await expect(olderUpdate).rejects.toThrow('disk full');
      expect(registry.getChat(CHAT_ID)?.model).toBe('model-c');
    } finally {
      releaseFirstSave.resolve();
      registry.saveRegistry = saveRegistry;
    }
  });

  it('does not roll back a replacement chat after its id is reused', async () => {
    registry.addChat(newChat());
    await registry.flush();
    registry = new ChatRegistry(tempDir);
    await registry.init();
    const saveEntered = deferred();
    const releaseSave = deferred();
    const saveRegistry = registry.saveRegistry.bind(registry);
    registry.saveRegistry = mock(async () => {
      saveEntered.resolve();
      await releaseSave.promise;
      throw new Error('disk full');
    });

    try {
      const failedUpdate = registry.updateChat(
        CHAT_ID,
        { model: 'model-b' },
        { flush: true },
      );
      await saveEntered.promise;
      expect(registry.removeChat(CHAT_ID)).toBe(true);
      expect(registry.addChat(newChat({ model: 'model-c' }))).toBe(true);
      releaseSave.resolve();
      await expect(failedUpdate).rejects.toThrow('disk full');
      expect(registry.getChat(CHAT_ID)?.model).toBe('model-c');
    } finally {
      releaseSave.resolve();
      registry.saveRegistry = saveRegistry;
    }
  });

  it('excludes a rolled-back patch from a queued save for another chat', async () => {
    registry.addChat(newChat());
    registry.addChat(newChat({ id: SECOND_CHAT_ID }));
    await registry.flush();
    const firstRenameEntered = deferred();
    const releaseFirstRename = deferred();
    const originalRename = fs.rename.bind(fs);
    let targetRenameCount = 0;
    const rename = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === path.join(tempDir, 'chats.json')) {
        targetRenameCount += 1;
        if (targetRenameCount === 1) {
          firstRenameEntered.resolve();
          await releaseFirstRename.promise;
          throw new Error('disk full');
        }
      }
      return originalRename(source, target);
    });

    try {
      const failedUpdate = registry.updateChat(
        CHAT_ID,
        { model: 'model-b' },
        { flush: true },
      );
      await firstRenameEntered.promise;
      const successfulUpdate = registry.updateChat(
        SECOND_CHAT_ID,
        { model: 'model-b' },
        { flush: true },
      );
      releaseFirstRename.resolve();
      await expect(failedUpdate).rejects.toThrow('disk full');
      await successfulUpdate;
    } finally {
      releaseFirstRename.resolve();
      rename.mockRestore();
    }

    registry = new ChatRegistry(tempDir);
    await registry.init();
    expect(registry.getChat(CHAT_ID)?.model).toBe('model-a');
    expect(registry.getChat(SECOND_CHAT_ID)?.model).toBe('model-b');
  });

  it('re-persists a rollback after another queued save captured the patch', async () => {
    registry = new ChatRegistry(tempDir, { saveDelayMs: 0 });
    await registry.init();
    registry.addChat(newChat());
    registry.addChat(newChat({ id: SECOND_CHAT_ID }));
    const firstRenameEntered = deferred();
    const releaseFirstRename = deferred();
    const rollbackPersisted = deferred();
    const originalRename = fs.rename.bind(fs);
    let wroteUnrolledBackSnapshot = false;
    let failureInjected = false;
    const rename = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === path.join(tempDir, 'chats.json')) {
        const snapshot = JSON.parse(await fs.readFile(source, 'utf8'));
        const firstModel = snapshot.sessions[CHAT_ID]?.model;
        const secondModel = snapshot.sessions[SECOND_CHAT_ID]?.model;
        if (firstModel === 'model-a' && secondModel === 'model-a') {
          firstRenameEntered.resolve();
          await releaseFirstRename.promise;
        } else if (firstModel === 'model-b' && secondModel === 'model-b') {
          if (!wroteUnrolledBackSnapshot) {
            wroteUnrolledBackSnapshot = true;
          } else {
            failureInjected = true;
            throw new Error('disk full');
          }
        } else if (
          failureInjected &&
          firstModel === 'model-b' &&
          secondModel === 'model-a'
        ) {
          await originalRename(source, target);
          rollbackPersisted.resolve();
          return;
        } else {
          throw new Error('disk full');
        }
      }
      return originalRename(source, target);
    });

    try {
      const blocker = registry.flush();
      await firstRenameEntered.promise;
      const firstUpdate = registry.updateChat(
        CHAT_ID,
        { model: 'model-b' },
        { flush: true },
      );
      const failedUpdate = registry.updateChat(
        SECOND_CHAT_ID,
        { model: 'model-b' },
        { flush: true },
      );
      releaseFirstRename.resolve();
      await blocker;
      await firstUpdate;
      await expect(failedUpdate).rejects.toThrow('disk full');
      await rollbackPersisted.promise;
    } finally {
      releaseFirstRename.resolve();
      rename.mockRestore();
    }

    expect(registry.getChat(SECOND_CHAT_ID)?.model).toBe('model-a');
    registry = new ChatRegistry(tempDir);
    await registry.init();
    expect(registry.getChat(SECOND_CHAT_ID)?.model).toBe('model-a');
  });

  it('persists dedicated project-path updates and emits only canonical metadata', async () => {
    registry.addChat(newChat({
      nativeSession: nativeSession('test'),
      preambleSelection: { revision: 1, orderedPreambleIds: [PREAMBLE_ID] },
    }));
    const listener = mock(() => undefined);
    registry.onChatProjectPathUpdated(listener);
    const callerSession = nativeSession('test', { path: '/tmp/next.jsonl' });

    const result = await registry.updateProjectPath(CHAT_ID, {
      chatId: CHAT_ID,
      projectPath: '/next',
      effectiveProjectKey: '/real/next',
      previousProjectPath: '/repo',
      previousEffectiveProjectKey: '/real/repo',
      nativeSession: callerSession,
    }, { flush: true });

    callerSession.value.injected = true;
    result.preambleSelection.orderedPreambleIds.length = 0;

    expect(result).toMatchObject({
      projectPath: '/next',
      nativeSession: nativeSession('test', { path: '/tmp/next.jsonl' }),
    });
    expect(registry.getChat(CHAT_ID).nativeSession.value).toEqual({ path: '/tmp/next.jsonl' });
    expect(registry.getChat(CHAT_ID).preambleSelection.orderedPreambleIds).toEqual([PREAMBLE_ID]);
    expect(listener).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      projectPath: '/next',
      effectiveProjectKey: '/real/next',
      previousProjectPath: '/repo',
      previousEffectiveProjectKey: '/real/repo',
    });
  });

  it('returns an isolated selection from native-session lookup', () => {
    registry.addChat(newChat({
      agentSessionId: 'native-1',
      preambleSelection: { revision: 1, orderedPreambleIds: [PREAMBLE_ID] },
    }));

    const result = registry.getChatByAgentSessionId('native-1');
    result[1].preambleSelection.orderedPreambleIds.length = 0;

    expect(registry.getChat(CHAT_ID).preambleSelection).toEqual({
      revision: 1,
      orderedPreambleIds: [PREAMBLE_ID],
    });
  });

  it('restores project-path fields in memory when persistence fails', async () => {
    const originalNativeSession = nativeSession('test');
    registry.addChat(newChat({ nativeSession: originalNativeSession }));
    const saveRegistry = registry.saveRegistry.bind(registry);
    registry.saveRegistry = mock(() => Promise.reject(new Error('disk full')));

    await expect(registry.updateProjectPath(CHAT_ID, {
      chatId: CHAT_ID,
      projectPath: '/next',
      effectiveProjectKey: '/next',
      previousProjectPath: '/repo',
      previousEffectiveProjectKey: '/repo',
      nativeSession: nativeSession('test', { path: '/tmp/next.jsonl' }),
    }, { flush: true })).rejects.toThrow('disk full');

    expect(registry.getChat(CHAT_ID)).toMatchObject({
      projectPath: '/repo',
      nativeSession: originalNativeSession,
    });

    registry.saveRegistry = saveRegistry;
  });

  it('removes records, indexes, and emits the removal identity', () => {
    registry.addChat(newChat({ agentSessionId: 'native-1' }));
    const removed = mock(() => undefined);
    registry.onChatRemoved(removed);

    expect(registry.removeChat(CHAT_ID)).toBe(true);
    expect(registry.removeChat(CHAT_ID)).toBe(false);
    expect(registry.getChatByAgentSessionId('native-1')).toBeNull();
    expect(removed).toHaveBeenCalledWith(CHAT_ID, 'user-deletion');
  });

  it('treats only an absent preamble selection as legacy and rejects explicit null', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-registry-null-'));
    await writeRegistry({
      [CHAT_ID]: {
        ...persistedEntry(),
        preambleSelection: null,
      },
    });
    registry = new ChatRegistry(tempDir);
    await expect(registry.init()).rejects.toThrow('Invalid preamble selection');

    // A present malformed value rejects as well; absence alone defaults.
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-registry-malformed-'));
    await writeRegistry({
      [CHAT_ID]: {
        ...persistedEntry(),
        preambleSelection: { revision: -1, orderedPreambleIds: [] },
      },
    });
    registry = new ChatRegistry(tempDir);
    await expect(registry.init()).rejects.toThrow('Invalid preamble selection');
  });

  it('binds a selection-change boundary to both the ownership epoch and selection revision', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-registry-binding-'));
    const badRevision = {
      ...persistedEntry({
        preambleSelection: { revision: 2, orderedPreambleIds: [] },
        pendingPreambleBoundary: {
          kind: 'selection-change',
          ownershipEpoch: 'epoch-1',
          selectionRevision: 1,
        },
      }),
    };
    await writeRegistry({ [CHAT_ID]: badRevision });
    registry = new ChatRegistry(tempDir);
    await expect(registry.init()).rejects.toThrow('selection revision mismatch');

    const badEpoch = persistedEntry({
      preambleSelection: { revision: 1, orderedPreambleIds: [] },
      pendingPreambleBoundary: {
        kind: 'selection-change',
        ownershipEpoch: 'other-epoch',
        selectionRevision: 1,
      },
    });
    await writeRegistry({ [CHAT_ID]: badEpoch });
    registry = new ChatRegistry(tempDir);
    await expect(registry.init()).rejects.toThrow('ownership epoch mismatch');

    // Ordinary updateChat enforces the same complete binding.
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-registry-binding-2-'));
    await writeRegistry({ [CHAT_ID]: persistedEntry() });
    registry = new ChatRegistry(tempDir);
    await registry.init();
    expect(() => registry.updateChat(CHAT_ID, {
      pendingPreambleBoundary: {
        kind: 'selection-change',
        ownershipEpoch: 'epoch-1',
        selectionRevision: 7,
      },
    })).toThrow('selection revision mismatch');
  });

  it('keeps a prior queued writer from persisting a pre-rename-rejected selection', async () => {
    const phasedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chats-phased-gated-'));
    const phasedRegistry = new ChatRegistry(phasedDir);
    await phasedRegistry.init();
    phasedRegistry.addChat({
      id: CHAT_ID,
      agentId: 'test',
      model: 'model-a',
      projectPath: '/repo',
      agentSettingsById: { test: envelope('test') },
      preambleSelection: { revision: 0, orderedPreambleIds: [] },
      pendingPreambleBoundary: null,
      parentChat: null,
    });
    await phasedRegistry.flush();

    const originalRename = fs.rename;
    const blocker = deferred();
    const blockerEntered = deferred();
    let chatsRenameCount = 0;
    fs.rename = async (source, destination) => {
      if (destination.endsWith('chats.json') && source.includes('.tmp')) {
        chatsRenameCount += 1;
        if (chatsRenameCount === 1) {
          blockerEntered.resolve();
          await blocker.promise;
        }
        if (chatsRenameCount === 3) throw new Error('disk full');
      }
      return originalRename(source, destination);
    };
    try {
      const blockingWriter = phasedRegistry.flush();
      await blockerEntered.promise;
      const priorQueuedWriter = phasedRegistry.flush();
      const gatedSelectionId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
      const phased = phasedRegistry.updateChatPhased(CHAT_ID, {
        preambleSelection: { revision: 1, orderedPreambleIds: [gatedSelectionId] },
      }).catch((error) => error);

      blocker.resolve();
      await blockingWriter;
      await priorQueuedWriter;
      await expect(phased).resolves.toMatchObject({ message: expect.stringContaining('disk full') });
    } finally {
      blocker.resolve();
      fs.rename = originalRename;
    }

    const onDisk = JSON.parse(await fs.readFile(path.join(phasedDir, 'chats.json'), 'utf8'));
    expect(onDisk.sessions[CHAT_ID].preambleSelection).toEqual({
      revision: 0,
      orderedPreambleIds: [],
    });
    expect(phasedRegistry.getChat(CHAT_ID).preambleSelection).toEqual({
      revision: 0,
      orderedPreambleIds: [],
    });
    await fs.rm(phasedDir, { recursive: true, force: true });
  });

  it('loads a strict version-five registry and rebuilds its native ID index', async () => {
    await registry.flush();
    await writeRegistry({ [CHAT_ID]: persistedEntry() });
    registry = new ChatRegistry(tempDir);

    await registry.init();

    expect(registry.getChat(CHAT_ID)).toEqual(persistedEntry());
    expect(registry.getChatByAgentSessionId('native-1')?.[0]).toBe(CHAT_ID);
  });

  it('normalizes absent and malformed persisted parentage to roots', async () => {
    const { parentChat: _parentChat, ...legacyEntry } = persistedEntry();
    const malformed = [
      'invalid',
      { chatId: 'invalid', relation: 'fork', transcriptViewId: 'view-a', ordinal: 1 },
      { chatId: CHAT_ID, relation: 'merge', transcriptViewId: 'view-a', ordinal: 1 },
      { chatId: CHAT_ID, relation: 'fork', transcriptViewId: '', ordinal: 1 },
      { chatId: CHAT_ID, relation: 'fork', transcriptViewId: 'view-a', ordinal: -1 },
    ];
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = mock((...args) => warnings.push(args));

    try {
      for (const entry of [legacyEntry, persistedEntry({ parentChat: null })]) {
        await writeRegistry({ [CHAT_ID]: entry });
        registry = new ChatRegistry(tempDir);
        await registry.init();
        expect(registry.getChat(CHAT_ID)?.parentChat).toBeNull();
      }
      expect(warnings).toEqual([]);

      for (const parentChat of malformed) {
        const warningCount = warnings.length;
        await writeRegistry({ [CHAT_ID]: { ...persistedEntry(), parentChat } });
        registry = new ChatRegistry(tempDir);
        await registry.init();
        expect(registry.getChat(CHAT_ID)?.parentChat).toBeNull();
        expect(warnings.slice(warningCount)).toEqual([
          ['[chats:store]', `sessions: ignoring invalid parentChat for ${CHAT_ID}`],
        ]);
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  it('strictly parses and freezes ordered carryover references', async () => {
    const segment = {
      id: '11111111-1111-4111-8111-111111111111',
      agentId: 'test',
      model: 'model-a',
      capturedAt: '2026-08-07T12:00:00.000Z',
      storedMessageCount: 2,
      visibleMessageCount: 1,
      trailingHandoff: { agentId: 'other', model: 'model-b' },
    };
    await registry.flush();
    await writeRegistry({ [CHAT_ID]: persistedEntry({ carryOverSegments: [segment] }) });
    registry = new ChatRegistry(tempDir);
    await registry.init();

    const entry = registry.getChat(CHAT_ID);
    expect(entry.carryOverSegments).toEqual([segment]);
    expect(Object.isFrozen(entry.carryOverSegments)).toBeTrue();
    expect(Object.isFrozen(entry.carryOverSegments[0])).toBeTrue();
    expect(Object.isFrozen(entry.carryOverSegments[0].trailingHandoff)).toBeTrue();
    expect(() => entry.carryOverSegments.push(segment)).toThrow();
  });

  it('rejects duplicate, empty, and out-of-range carryover references', async () => {
    const segment = {
      id: '11111111-1111-4111-8111-111111111111',
      agentId: 'test',
      model: '',
      capturedAt: '2026-08-07T12:00:00.000Z',
      storedMessageCount: 1,
      visibleMessageCount: 1,
      trailingHandoff: null,
    };
    for (const carryOverSegments of [
      [segment, segment],
      [{ ...segment, storedMessageCount: 0, visibleMessageCount: 0 }],
      [{ ...segment, visibleMessageCount: 2 }],
    ]) {
      await writeRegistry({ [CHAT_ID]: persistedEntry({ carryOverSegments }) });
      registry = new ChatRegistry(tempDir);
      await expect(registry.init()).rejects.toThrow();
    }
  });

  it('rejects malformed ownership, settings, and native-session records', async () => {
    for (const entry of [
      persistedEntry({ agentOwnershipEpoch: '' }),
      persistedEntry({
        pendingPreambleBoundary: {
          kind: 'new-chat',
          ownershipEpoch: 'stale-epoch',
        },
      }),
      persistedEntry({ agentSettingsById: null }),
      persistedEntry({ nativeSession: nativeSession('other') }),
    ]) {
      await writeRegistry({ [CHAT_ID]: entry });
      registry = new ChatRegistry(tempDir);
      await expect(registry.init()).rejects.toThrow();
    }
  });

  it('reconciles missing opaque native sessions through the owning integration callback', async () => {
    registry.addChat(newChat({ agentSessionId: 'native-1' }));
    const resolved = nativeSession('test', { id: 'native-1' });
    const resolver = mock(async () => resolved);

    await expect(registry.reconcileSessions(resolver)).resolves.toBe(true);

    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'test' }), CHAT_ID);
    expect(registry.getChat(CHAT_ID)?.nativeSession).toEqual(nativeSession('test', { id: 'native-1' }));
    await expect(registry.reconcileSessions(resolver)).resolves.toBe(false);
    expect(resolver).toHaveBeenCalledTimes(2);

    resolved.value.injected = true;
    expect(registry.getChat(CHAT_ID)?.nativeSession).toEqual(nativeSession('test', { id: 'native-1' }));
  });

  it('replaces an existing opaque native session only when the resolver upgrades it', async () => {
    const artificial = nativeSession('test', { path: '!test:native-1' });
    const resolved = nativeSession('test', { path: '/sessions/native-1.jsonl' });
    registry.addChat(newChat({ agentSessionId: 'native-1', nativeSession: artificial }));

    await expect(registry.reconcileSessions(async () => resolved)).resolves.toBe(true);
    expect(registry.getChat(CHAT_ID)?.nativeSession).toEqual(resolved);
    await expect(registry.reconcileSessions(async () => resolved)).resolves.toBe(false);
  });

  it('preserves unresolved sessions and rejects a resolver owner mismatch', async () => {
    registry.addChat(newChat({ agentSessionId: 'native-1' }));
    await expect(registry.reconcileSessions(async () => null)).resolves.toBe(false);
    expect(registry.getChat(CHAT_ID)?.nativeSession).toBeNull();
    await expect(registry.reconcileSessions(async () => nativeSession('other')))
      .rejects.toThrow('Native session owner mismatch');
  });

  it('rejects invalid chat IDs before mutation', () => {
    expect(() => registry.addChat(newChat({ id: 'not-a-chat-id' }))).toThrow();
    expect(registry.listAllChats()).toEqual({});
  });
});
