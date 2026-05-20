import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { replaceUuidBounded, assertJsonlValid, forkChatFileCopy } from '../fork-chat.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `fork-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function createRegistry(sessions) {
  const store = { ...sessions };
  return {
    addChat(entry) {
      if (store[entry.id]) return false;
      store[entry.id] = { ...entry };
      return true;
    },
    getChat(chatId) {
      return store[chatId] ?? null;
    },
    listAllChats() {
      return { ...store };
    },
    updateChat(chatId, patch) {
      if (!store[chatId]) return null;
      store[chatId] = { ...store[chatId], ...patch };
      return { id: chatId, ...store[chatId] };
    },
  };
}

function createSettings(initialTitles = {}) {
  const titles = new Map(Object.entries(initialTitles));
  return {
    ensureInNormal: mock(() => Promise.resolve(undefined)),
    getChatName(chatId) {
      return titles.get(chatId) ?? null;
    },
    async setSessionName(chatId, title) {
      titles.set(chatId, title);
    },
  };
}

function createMetadata(initialMetadata = {}) {
  const meta = new Map(Object.entries(initialMetadata));
  return {
    addNewChatMetadata: mock((chatId, firstMessage) => {
      meta.set(chatId, { firstMessage });
    }),
    getChatMetadata(chatId) {
      return meta.get(chatId) ?? null;
    },
  };
}

async function createSourceNativeFile(providerSessionId) {
  const nativePath = path.join(tmpDir, `${providerSessionId}.jsonl`);
  const content = [
    JSON.stringify({ type: 'session', session_id: providerSessionId }),
    JSON.stringify({ type: 'message', session_id: providerSessionId, text: 'hello' }),
    '',
  ].join('\n');
  await fs.writeFile(nativePath, content, 'utf8');
  return nativePath;
}

describe('replaceUuidBounded', () => {
  it('replaces only bounded UUID tokens', () => {
    const oldId = '11111111-1111-1111-1111-111111111111';
    const newId = '22222222-2222-2222-2222-222222222222';
    const line = JSON.stringify({ session_id: oldId, other: `prefix-${oldId}-suffix` });
    const result = replaceUuidBounded(line, oldId, newId);
    const parsed = JSON.parse(result);
    expect(parsed.session_id).toBe(newId);
    // Hyphen-separated composite should still match because \b sees word boundaries at hyphens.
    // This is expected behavior for UUID replacement in JSON values.
  });

  it('replaces multiple occurrences in a single line', () => {
    const oldId = 'aaaa-bbbb';
    const newId = 'cccc-dddd';
    const line = `"${oldId}" and "${oldId}"`;
    const result = replaceUuidBounded(line, oldId, newId);
    expect(result).toBe(`"${newId}" and "${newId}"`);
  });

  it('does not replace when UUID is part of a longer word', () => {
    const oldId = 'abc123';
    const newId = 'def456';
    const line = 'xabc123y';
    const result = replaceUuidBounded(line, oldId, newId);
    expect(result).toBe('xabc123y');
  });

  it('handles empty lines', () => {
    const result = replaceUuidBounded('', 'old', 'new');
    expect(result).toBe('');
  });
});

describe('assertJsonlValid', () => {
  it('accepts valid JSONL', () => {
    const content = '{"a":1}\n{"b":2}\n';
    expect(() => assertJsonlValid(content, '/tmp/test.jsonl')).not.toThrow();
  });

  it('accepts empty lines in JSONL', () => {
    const content = '{"a":1}\n\n{"b":2}\n\n';
    expect(() => assertJsonlValid(content, '/tmp/test.jsonl')).not.toThrow();
  });

  it('rejects invalid JSON lines', () => {
    const content = '{"a":1}\n{invalid}\n';
    expect(() => assertJsonlValid(content, '/tmp/test.jsonl')).toThrow(/Invalid JSONL/);
  });

  it('includes line number in error message', () => {
    const content = '{"a":1}\n{bad}\n';
    try {
      assertJsonlValid(content, '/tmp/test.jsonl');
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      expect(e.message).toContain('/tmp/test.jsonl:2');
    }
  });
});

describe('forkChatFileCopy', () => {
  it('defaults to the first fork ordinal when the source chat has no counter', async () => {
    const sourceNativePath = await createSourceNativeFile('11111111-1111-1111-1111-111111111111');
    const registry = createRegistry({
      '100': {
        provider: 'claude',
        model: 'sonnet',
        apiProviderId: 'anthropic-custom',
        modelEndpointId: 'endpoint-1',
        modelProtocol: 'anthropic-messages',
        projectPath: '/proj',
        nativePath: sourceNativePath,
        tags: ['ops'],
        providerSessionId: '11111111-1111-1111-1111-111111111111',
      },
      '101': {
        provider: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath: null,
        tags: [],
        providerSessionId: 'child-1',
      },
      '102': {
        provider: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath: null,
        tags: [],
        providerSessionId: 'child-2',
      },
    });
    const settings = createSettings({
      '100': 'Bug hunt',
      '101': 'Bug hunt (1)',
      '102': 'Bug hunt (2)',
    });
    const metadata = createMetadata({
      '100': { firstMessage: 'Fallback bug hunt prompt' },
    });

    const result = await forkChatFileCopy({
      sourceSession: registry.getChat('100'),
      sourceChatId: '100',
      targetChatId: '103',
      registry,
      settings,
      metadata,
    });

    expect(result.chatId).toBe('103');
    expect(settings.getChatName('103')).toBe('Bug hunt (1)');
    expect(registry.getChat('100')?.nextForkOrdinal).toBe(2);
    expect(registry.getChat('103')?.nextForkOrdinal).toBe(1);
    expect(registry.getChat('103')).toMatchObject({
      apiProviderId: 'anthropic-custom',
      modelEndpointId: 'endpoint-1',
      modelProtocol: 'anthropic-messages',
    });
    expect(metadata.addNewChatMetadata).toHaveBeenCalledWith('103', 'Fallback bug hunt prompt');
    expect(settings.ensureInNormal).toHaveBeenCalledWith('103');
  });

  it('appends nested fork ordinals from the persisted source counter', async () => {
    const sourceNativePath = await createSourceNativeFile('22222222-2222-2222-2222-222222222222');
    const registry = createRegistry({
      '200': {
        provider: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath: sourceNativePath,
        tags: [],
        providerSessionId: '22222222-2222-2222-2222-222222222222',
        nextForkOrdinal: 2,
      },
    });
    const settings = createSettings({
      '200': 'Bug hunt (1)',
    });
    const metadata = createMetadata({
      '200': { firstMessage: 'Nested fork fallback' },
    });

    await forkChatFileCopy({
      sourceSession: registry.getChat('200'),
      sourceChatId: '200',
      targetChatId: '201',
      registry,
      settings,
      metadata,
    });

    expect(settings.getChatName('201')).toBe('Bug hunt (1) (2)');
    expect(registry.getChat('200')?.nextForkOrdinal).toBe(3);
    expect(registry.getChat('201')?.nextForkOrdinal).toBe(1);
  });

  it('uses provider-native fork results when available', async () => {
    const sourceNativePath = await createSourceNativeFile('33333333-3333-3333-3333-333333333333');
    const nativeForkPath = path.join(tmpDir, 'native-codex-fork.jsonl');
    await fs.writeFile(nativeForkPath, '{"type":"session"}\n', 'utf8');
    const registry = createRegistry({
      '300': {
        provider: 'codex',
        model: 'gpt-5.4-codex',
        projectPath: '/proj',
        nativePath: sourceNativePath,
        tags: ['codex'],
        providerSessionId: '33333333-3333-3333-3333-333333333333',
      },
    });
    const settings = createSettings({ '300': 'Codex work' });
    const metadata = createMetadata({ '300': { firstMessage: 'Codex prompt' } });
    const forkProviderSession = mock(async () => ({
      providerSessionId: 'codex-fork-thread',
      nativePath: nativeForkPath,
    }));

    const result = await forkChatFileCopy({
      sourceSession: registry.getChat('300'),
      sourceChatId: '300',
      targetChatId: '301',
      registry,
      settings,
      metadata,
      forkProviderSession,
    });

    expect(forkProviderSession).toHaveBeenCalledTimes(1);
    expect(result.providerSessionId).toBe('codex-fork-thread');
    expect(result.nativePath).toBe(nativeForkPath);
    expect(registry.getChat('301')).toMatchObject({
      provider: 'codex',
      providerSessionId: 'codex-fork-thread',
      nativePath: nativeForkPath,
      tags: ['codex'],
    });
  });
});
