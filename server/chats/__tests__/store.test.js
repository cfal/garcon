import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
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
    ...overrides,
  };
}

async function writeRegistry(sessions, version = 3) {
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
    expect(persisted.version).toBe(3);
    expect(persisted.sessions[CHAT_ID]).toMatchObject({
      agentSessionId: 'native-1',
      nativeSession: nativeSession('test', { id: 'native-1' }),
    });
    expect(persisted.sessions[CHAT_ID].nativePath).toBeUndefined();
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

  it('removes records, indexes, and emits the removal identity', () => {
    registry.addChat(newChat({ agentSessionId: 'native-1' }));
    const removed = mock(() => undefined);
    registry.onChatRemoved(removed);

    expect(registry.removeChat(CHAT_ID)).toBe(true);
    expect(registry.removeChat(CHAT_ID)).toBe(false);
    expect(registry.getChatByAgentSessionId('native-1')).toBeNull();
    expect(removed).toHaveBeenCalledWith(CHAT_ID);
  });

  it('loads a strict version-three registry and rebuilds its native ID index', async () => {
    await registry.flush();
    await writeRegistry({ [CHAT_ID]: persistedEntry() });
    registry = new ChatRegistry(tempDir);

    await registry.init();

    expect(registry.getChat(CHAT_ID)).toEqual(persistedEntry());
    expect(registry.getChatByAgentSessionId('native-1')?.[0]).toBe(CHAT_ID);
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
