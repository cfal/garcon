import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatRegistry } from '../store.ts';

const CHAT_ID = '1783725900000200';
const SECOND_CHAT_ID = '1783725900000201';
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
    }));

    const chat = registry.getChat(CHAT_ID);
    chat.tags.push('injected');
    chat.agentSettingsById.test.values.injected = true;

    const updated = registry.updateChat(CHAT_ID, { model: 'other-model' });
    updated.tags.push('via-update');
    updated.agentSettingsById.test.values.injected = true;

    expect(registry.getChat(CHAT_ID).tags).toEqual(['source']);
    expect(registry.getChat(CHAT_ID).agentSettingsById.test.values).toEqual({});
  });

  it('clones caller-owned collections on ingest', () => {
    const tags = ['source'];
    const agentSettingsById = { test: envelope('test') };
    registry.addChat(newChat({ tags, agentSettingsById }));

    tags.push('injected');
    agentSettingsById.test.values.injected = true;

    expect(registry.getChat(CHAT_ID).tags).toEqual(['source']);
    expect(registry.getChat(CHAT_ID).agentSettingsById.test.values).toEqual({});
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
    registry.addChat(newChat({ tags: ['existing'] }));
    const updated = [];
    registry.onChatTagsUpdated((chatId) => updated.push(chatId));

    expect(registry.addTags(CHAT_ID, ['CLI', 'existing', 'Review Needed'])).toMatchObject({
      tags: ['cli', 'existing', 'review-needed'],
    });
    expect(registry.addTags(CHAT_ID, ['cli'])).toMatchObject({
      tags: ['cli', 'existing', 'review-needed'],
    });
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
    registry.addChat(newChat({ nativeSession: nativeSession('test') }));
    const listener = mock(() => undefined);
    registry.onChatProjectPathUpdated(listener);

    const result = await registry.updateProjectPath(CHAT_ID, {
      chatId: CHAT_ID,
      projectPath: '/next',
      effectiveProjectKey: '/real/next',
      previousProjectPath: '/repo',
      previousEffectiveProjectKey: '/real/repo',
      nativeSession: nativeSession('test', { path: '/tmp/next.jsonl' }),
    }, { flush: true });

    expect(result).toMatchObject({
      projectPath: '/next',
      nativeSession: nativeSession('test', { path: '/tmp/next.jsonl' }),
    });
    expect(listener).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      projectPath: '/next',
      effectiveProjectKey: '/real/next',
      previousProjectPath: '/repo',
      previousEffectiveProjectKey: '/real/repo',
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
    const resolver = mock(async () => nativeSession('test', { id: 'native-1' }));

    await expect(registry.reconcileSessions(resolver)).resolves.toBe(true);

    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'test' }), CHAT_ID);
    expect(registry.getChat(CHAT_ID)?.nativeSession).toEqual(nativeSession('test', { id: 'native-1' }));
    await expect(registry.reconcileSessions(resolver)).resolves.toBe(false);
    expect(resolver).toHaveBeenCalledTimes(2);
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
