import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  replaceUuidBounded,
  assertJsonlValid,
  sanitizeForkJsonl,
  truncateJsonlAfterEntryId,
  truncateJsonlAfterLine,
  forkChatFileCopy,
} from '../fork-chat.js';

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

async function createSourceNativeFile(agentSessionId) {
  const nativePath = path.join(tmpDir, `${agentSessionId}.jsonl`);
  const content = [
    JSON.stringify({ type: 'session', session_id: agentSessionId }),
    JSON.stringify({ type: 'message', session_id: agentSessionId, text: 'hello' }),
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

describe('sanitizeForkJsonl', () => {
  it('keeps fully valid JSONL untouched', () => {
    const content = '{"a":1}\n{"b":2}\n';
    expect(sanitizeForkJsonl(content, '/tmp/test.jsonl')).toBe(content);
  });

  it('drops a trailing incomplete line from an in-flight write', () => {
    const content = '{"a":1}\n{"b":2}\n{"c":';
    const result = sanitizeForkJsonl(content, '/tmp/test.jsonl');
    expect(result).toBe('{"a":1}\n{"b":2}');
    expect(() => assertJsonlValid(result, '/tmp/test.jsonl')).not.toThrow();
  });

  it('throws when a malformed line is followed by more content', () => {
    const content = '{"a":1}\n{bad}\n{"c":3}\n';
    expect(() => sanitizeForkJsonl(content, '/tmp/test.jsonl')).toThrow(/Invalid JSONL/);
  });
});

describe('truncateJsonlAfterLine', () => {
  it('keeps content through the requested one-based line', () => {
    const content = '{"a":1}\n{"b":2}\n{"c":3}\n';
    expect(truncateJsonlAfterLine(content, 2)).toBe('{"a":1}\n{"b":2}');
  });

  it('keeps full content when the requested line is past the file', () => {
    const content = '{"a":1}\n{"b":2}\n';
    expect(truncateJsonlAfterLine(content, 5)).toBe(content);
  });
});

describe('truncateJsonlAfterEntryId', () => {
  it('keeps content through the matching JSONL entry id', () => {
    const content = [
      JSON.stringify({ uuid: 'entry-1', text: 'first' }),
      JSON.stringify({ uuid: 'entry-2', text: 'second' }),
      '{"uuid":"entry-3","text":"partial',
    ].join('\n');

    expect(truncateJsonlAfterEntryId(content, 'entry-2')).toBe([
      JSON.stringify({ uuid: 'entry-1', text: 'first' }),
      JSON.stringify({ uuid: 'entry-2', text: 'second' }),
    ].join('\n'));
  });

  it('returns null when the JSONL entry id is unavailable', () => {
    const content = `${JSON.stringify({ uuid: 'entry-1' })}\n`;
    expect(truncateJsonlAfterEntryId(content, 'missing-entry')).toBeNull();
  });
});

describe('forkChatFileCopy', () => {
  it('snapshots up to the last completed turn when the source is mid-write', async () => {
    const agentSessionId = '44444444-4444-4444-4444-444444444444';
    const nativePath = path.join(tmpDir, `${agentSessionId}.jsonl`);
    const partial = [
      JSON.stringify({ type: 'session', session_id: agentSessionId }),
      JSON.stringify({ type: 'message', session_id: agentSessionId, text: 'done' }),
      '{"type":"message","session_id":"' + agentSessionId + '","text":"in-fli',
    ].join('\n');
    await fs.writeFile(nativePath, partial, 'utf8');

    const registry = createRegistry({
      '400': {
        agentId: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath,
        tags: [],
        agentSessionId,
      },
    });
    const settings = createSettings({ '400': 'Live turn' });
    const metadata = createMetadata({ '400': { firstMessage: 'Live prompt' } });

    const result = await forkChatFileCopy({
      sourceSession: registry.getChat('400'),
      sourceChatId: '400',
      targetChatId: '401',
      registry,
      settings,
      metadata,
    });

    const forked = await fs.readFile(result.nativePath, 'utf8');
    expect(() => assertJsonlValid(forked, result.nativePath)).not.toThrow();
    expect(forked).not.toContain('in-fli');
    expect(forked).toContain('"text":"done"');
  });


  it('defaults to the first fork ordinal when the source chat has no counter', async () => {
    const sourceNativePath = await createSourceNativeFile('11111111-1111-1111-1111-111111111111');
    const registry = createRegistry({
      '100': {
        agentId: 'claude',
        model: 'sonnet',
        apiProviderId: 'anthropic-custom',
        modelEndpointId: 'endpoint-1',
        modelProtocol: 'anthropic-messages',
        projectPath: '/proj',
        nativePath: sourceNativePath,
        tags: ['ops'],
        agentSessionId: '11111111-1111-1111-1111-111111111111',
        permissionMode: 'acceptEdits',
        thinkingMode: 'think-hard',
        claudeThinkingMode: 'off',
        ampAgentMode: 'deep',
      },
      '101': {
        agentId: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath: null,
        tags: [],
        agentSessionId: 'child-1',
      },
      '102': {
        agentId: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath: null,
        tags: [],
        agentSessionId: 'child-2',
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
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
      claudeThinkingMode: 'off',
      ampAgentMode: 'deep',
    });
    expect(metadata.addNewChatMetadata).toHaveBeenCalledWith('103', 'Fallback bug hunt prompt');
    expect(settings.ensureInNormal).toHaveBeenCalledWith('103');
  });

  it('appends nested fork ordinals from the persisted source counter', async () => {
    const sourceNativePath = await createSourceNativeFile('22222222-2222-2222-2222-222222222222');
    const registry = createRegistry({
      '200': {
        agentId: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath: sourceNativePath,
        tags: [],
        agentSessionId: '22222222-2222-2222-2222-222222222222',
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

  it('uses agent-native fork results when available', async () => {
    const sourceNativePath = await createSourceNativeFile('33333333-3333-3333-3333-333333333333');
    const nativeForkPath = path.join(tmpDir, 'native-codex-fork.jsonl');
    await fs.writeFile(nativeForkPath, '{"type":"session"}\n', 'utf8');
    const registry = createRegistry({
      '300': {
        agentId: 'codex',
        model: 'gpt-5.4-codex',
        projectPath: '/proj',
        nativePath: sourceNativePath,
        tags: ['codex'],
        agentSessionId: '33333333-3333-3333-3333-333333333333',
      },
    });
    const settings = createSettings({ '300': 'Codex work' });
    const metadata = createMetadata({ '300': { firstMessage: 'Codex prompt' } });
    const forkAgentSession = mock(async () => ({
      agentSessionId: 'codex-fork-thread',
      nativePath: nativeForkPath,
    }));

    const result = await forkChatFileCopy({
      sourceSession: registry.getChat('300'),
      sourceChatId: '300',
      targetChatId: '301',
      registry,
      settings,
      metadata,
      forkAgentSession,
    });

    expect(forkAgentSession).toHaveBeenCalledTimes(1);
    expect(result.agentSessionId).toBe('codex-fork-thread');
    expect(result.nativePath).toBe(nativeForkPath);
    expect(registry.getChat('301')).toMatchObject({
      agentId: 'codex',
      agentSessionId: 'codex-fork-thread',
      nativePath: nativeForkPath,
      tags: ['codex'],
    });
  });

  it('truncates raw file copy for message-point forks before an active tail', async () => {
    const agentSessionId = '55555555-5555-5555-5555-555555555555';
    const nativePath = path.join(tmpDir, `${agentSessionId}.jsonl`);
    const content = [
      JSON.stringify({ type: 'session', session_id: agentSessionId }),
      JSON.stringify({ type: 'message', session_id: agentSessionId, uuid: 'keep-entry', text: 'keep' }),
      JSON.stringify({ type: 'message', session_id: agentSessionId, uuid: 'drop-entry', text: 'drop' }),
      '{"type":"message","text":"partial',
    ].join('\n');
    await fs.writeFile(nativePath, content, 'utf8');
    const registry = createRegistry({
      '500': {
        agentId: 'codex',
        model: 'gpt-5.4-codex',
        projectPath: '/proj',
        nativePath,
        tags: [],
        agentSessionId,
      },
    });
    const settings = createSettings({ '500': 'Point fork' });
    const metadata = createMetadata({ '500': { firstMessage: 'Point prompt' } });
    const forkAgentSession = mock(async () => ({
      agentSessionId: 'native-should-not-run',
      nativePath: path.join(tmpDir, 'native-should-not-run.jsonl'),
    }));

    const result = await forkChatFileCopy({
      sourceSession: registry.getChat('500'),
      sourceChatId: '500',
      targetChatId: '501',
      truncateAfterEntryId: 'keep-entry',
      truncateAfterLine: 2,
      registry,
      settings,
      metadata,
      forkAgentSession,
    });

    const forked = await fs.readFile(result.nativePath, 'utf8');
    expect(forkAgentSession).not.toHaveBeenCalled();
    expect(() => assertJsonlValid(forked, result.nativePath)).not.toThrow();
    expect(forked).toContain('"text":"keep"');
    expect(forked).not.toContain('"text":"drop"');
    expect(forked).not.toContain('partial');
    expect(forked).toContain(result.agentSessionId);
    expect(forked).not.toContain(agentSessionId);
  });
});
