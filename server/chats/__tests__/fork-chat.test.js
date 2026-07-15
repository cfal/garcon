import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  rewriteForkSessionId,
  assertJsonlValid,
  normalizeForkJsonl,
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

describe('rewriteForkSessionId', () => {
  it('rewrites only top-level native session identity fields', () => {
    const oldId = '11111111-1111-1111-1111-111111111111';
    const newId = '22222222-2222-2222-2222-222222222222';
    const line = JSON.stringify({
      sessionId: oldId,
      session_id: oldId,
      content: oldId,
      message: { sessionId: oldId },
    });
    const result = rewriteForkSessionId(line, oldId, newId);
    const parsed = JSON.parse(result);
    expect(parsed.sessionId).toBe(newId);
    expect(parsed.session_id).toBe(newId);
    expect(parsed.content).toBe(oldId);
    expect(parsed.message.sessionId).toBe(oldId);
  });

  it('handles empty lines', () => {
    const result = rewriteForkSessionId('', 'old', 'new');
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

describe('normalizeForkJsonl', () => {
  it('keeps fully valid JSONL untouched', () => {
    const content = '{"a":1}\n{"b":2}\n';
    expect(normalizeForkJsonl(content, '/tmp/test.jsonl')).toEqual({
      content,
      discardedSuffixLines: 0,
      droppedIncompleteTail: false,
    });
  });

  it('drops a trailing incomplete line from an in-flight write', () => {
    const content = '{"a":1}\n{"b":2}\n{"c":';
    const result = normalizeForkJsonl(content, '/tmp/test.jsonl');
    expect(result).toEqual({
      content: '{"a":1}\n{"b":2}',
      discardedSuffixLines: 0,
      droppedIncompleteTail: true,
    });
    expect(() => assertJsonlValid(result.content, '/tmp/test.jsonl')).not.toThrow();
  });

  it('throws when a malformed line is followed by more content', () => {
    const content = '{"a":1}\n{bad}\n{"c":3}\n';
    expect(() => normalizeForkJsonl(content, '/tmp/test.jsonl')).toThrow(/Invalid JSONL/);
  });

  it('keeps the first value and reports discarded suffix content', () => {
    const first = JSON.stringify({ type: 'user', uuid: 'entry-1' });
    const suffix = JSON.stringify({ type: 'mode', mode: 'normal' });

    expect(normalizeForkJsonl(`${first}${suffix}\n`, '/tmp/test.jsonl')).toEqual({
      content: `${first}\n`,
      discardedSuffixLines: 1,
      droppedIncompleteTail: false,
    });
  });

  it('keeps a complete first value before a partial suffix', () => {
    const first = JSON.stringify({ type: 'user', uuid: 'entry-1' });

    expect(normalizeForkJsonl(`${first}{"type":`, '/tmp/test.jsonl')).toEqual({
      content: first,
      discardedSuffixLines: 1,
      droppedIncompleteTail: false,
    });
  });

  it('rejects a wholly malformed final line', () => {
    expect(() => normalizeForkJsonl('{bad}', '/tmp/test.jsonl')).toThrow(/Invalid JSONL/);
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

  it('forks the first value from a concatenated line and warns once', async () => {
    const agentSessionId = '77777777-7777-7777-7777-777777777777';
    const nativePath = path.join(tmpDir, `${agentSessionId}.jsonl`);
    const firstLine = JSON.stringify({ type: 'session', sessionId: agentSessionId });
    const recoveredLine = JSON.stringify({
      type: 'user',
      uuid: 'recovered-entry',
      sessionId: agentSessionId,
      message: { role: 'user', content: 'keep recovered' },
    });
    const discardedSuffix = JSON.stringify({ type: 'mode', mode: 'normal', sessionId: agentSessionId });
    const lastLine = JSON.stringify({
      type: 'assistant',
      uuid: 'last-entry',
      sessionId: agentSessionId,
      message: { role: 'assistant', content: 'keep later' },
    });
    const sourceContent = `${firstLine}\n${recoveredLine}${discardedSuffix}\n${lastLine}`;
    await fs.writeFile(nativePath, sourceContent, 'utf8');
    const registry = createRegistry({
      '700': {
        agentId: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath,
        tags: [],
        agentSessionId,
      },
    });
    const settings = createSettings({ '700': 'Recovered fork' });
    const metadata = createMetadata({ '700': { firstMessage: 'Recovered prompt' } });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await forkChatFileCopy({
        sourceSession: registry.getChat('700'),
        sourceChatId: '700',
        targetChatId: '701',
        registry,
        settings,
        metadata,
      });

      const forked = await fs.readFile(result.nativePath, 'utf8');
      const parsed = forked.trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(parsed.map((entry) => entry.type)).toEqual(['session', 'user', 'assistant']);
      expect(forked).toContain('keep recovered');
      expect(forked).toContain('keep later');
      expect(forked).not.toContain('"type":"mode"');
      expect(forked).not.toContain(agentSessionId);
      expect(forked.endsWith('\n')).toBe(true);
      expect(await fs.readFile(nativePath, 'utf8')).toBe(sourceContent);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[chats:fork]',
        'discarded JSONL suffixes after the first value on 1 line(s) for chat 700',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('revalidates the source after reading before creating the fork', async () => {
    const agentSessionId = '88888888-8888-4888-8888-888888888888';
    const nativePath = await createSourceNativeFile(agentSessionId);
    const registry = createRegistry({
      '800': {
        agentId: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath,
        tags: [],
        agentSessionId,
      },
    });
    const assertSourceSnapshotStable = mock(() => {
      if (assertSourceSnapshotStable.mock.calls.length === 2) {
        throw new Error('source changed while reading');
      }
    });

    await expect(forkChatFileCopy({
      sourceSession: registry.getChat('800'),
      sourceChatId: '800',
      targetChatId: '801',
      registry,
      settings: createSettings(),
      metadata: createMetadata(),
      assertSourceSnapshotStable,
    })).rejects.toThrow('source changed while reading');

    expect(assertSourceSnapshotStable).toHaveBeenCalledTimes(2);
    expect(registry.getChat('801')).toBeNull();
  });

  it('copies a complete Direct transcript into the same endpoint directory', async () => {
    const agentSessionId = '99999999-9999-4999-8999-999999999999';
    const endpointDir = path.join(tmpDir, 'openai-compatible-sessions', 'acme_openai');
    const nativePath = path.join(endpointDir, `${agentSessionId}.jsonl`);
    const sourceContent = [
      JSON.stringify({ role: 'user', content: `debug session ${agentSessionId}`, timestamp: '2026-07-15T10:00:00.000Z' }),
      JSON.stringify({ role: 'assistant', content: 'hi', timestamp: '2026-07-15T10:00:01.000Z' }),
      '',
    ].join('\n');
    await fs.mkdir(endpointDir, { recursive: true });
    await fs.writeFile(nativePath, sourceContent, 'utf8');
    const registry = createRegistry({
      '900': {
        agentId: 'direct-openai-compatible',
        model: 'acme-model',
        apiProviderId: 'acme',
        modelEndpointId: 'acme_openai',
        modelProtocol: 'openai-compatible',
        projectPath: '/repos/source',
        nativePath,
        tags: ['direct'],
        agentSessionId,
      },
    });
    const settings = createSettings({ '900': 'Direct source' });
    const metadata = createMetadata({ '900': { firstMessage: 'hello' } });

    const result = await forkChatFileCopy({
      sourceSession: registry.getChat('900'),
      sourceChatId: '900',
      targetChatId: '901',
      registry,
      settings,
      metadata,
    });

    const forked = await fs.readFile(result.nativePath, 'utf8');
    const forkedLines = forked.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(path.dirname(result.nativePath)).toBe(endpointDir);
    expect(path.basename(result.nativePath)).toBe(`${result.agentSessionId}.jsonl`);
    expect(forkedLines).toEqual([
      { role: 'user', content: `debug session ${agentSessionId}`, timestamp: '2026-07-15T10:00:00.000Z' },
      { role: 'assistant', content: 'hi', timestamp: '2026-07-15T10:00:01.000Z' },
    ]);
    expect(forked.endsWith('\n')).toBe(true);
    expect(await fs.readFile(nativePath, 'utf8')).toBe(sourceContent);
    expect(registry.getChat('901')).toMatchObject({
      agentId: 'direct-openai-compatible',
      model: 'acme-model',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
      modelProtocol: 'openai-compatible',
      projectPath: '/repos/source',
      nativePath: result.nativePath,
      agentSessionId: result.agentSessionId,
      tags: ['direct'],
    });
  });

  it('truncates a Direct transcript at the selected physical line', async () => {
    const agentSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const endpointDir = path.join(tmpDir, 'anthropic-compatible-sessions', 'acme_anthropic');
    const nativePath = path.join(endpointDir, `${agentSessionId}.jsonl`);
    const sourceContent = [
      JSON.stringify({ role: 'user', content: 'first' }),
      JSON.stringify({ role: 'assistant', content: 'second' }),
      JSON.stringify({ role: 'user', content: 'drop' }),
      '',
    ].join('\n');
    await fs.mkdir(endpointDir, { recursive: true });
    await fs.writeFile(nativePath, sourceContent, 'utf8');
    const registry = createRegistry({
      '910': {
        agentId: 'direct-anthropic-compatible',
        model: 'acme-model',
        projectPath: '/repos/source',
        nativePath,
        tags: [],
        agentSessionId,
      },
    });

    const result = await forkChatFileCopy({
      sourceSession: registry.getChat('910'),
      sourceChatId: '910',
      targetChatId: '911',
      truncateAfterLine: 2,
      registry,
      settings: createSettings({ '910': 'Direct point' }),
      metadata: createMetadata({ '910': { firstMessage: 'first' } }),
    });

    const forked = await fs.readFile(result.nativePath, 'utf8');
    expect(forked.trimEnd().split('\n').map((line) => JSON.parse(line))).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
    expect(forked).not.toContain('drop');
    expect(await fs.readFile(nativePath, 'utf8')).toBe(sourceContent);
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
        thinkingMode: 'medium',
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
      thinkingMode: 'medium',
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

  it('forks at the first value on a concatenated message-point line', async () => {
    const agentSessionId = '88888888-8888-8888-8888-888888888888';
    const nativePath = path.join(tmpDir, `${agentSessionId}.jsonl`);
    const keep = JSON.stringify({
      type: 'user',
      uuid: 'keep-entry',
      sessionId: agentSessionId,
      message: { role: 'user', content: 'keep' },
    });
    const discarded = JSON.stringify({ type: 'mode', mode: 'normal', sessionId: agentSessionId });
    const drop = JSON.stringify({
      type: 'assistant',
      uuid: 'drop-entry',
      sessionId: agentSessionId,
      message: { role: 'assistant', content: 'drop' },
    });
    await fs.writeFile(nativePath, `${keep}${discarded}\n${drop}\n{bad}`, 'utf8');
    const registry = createRegistry({
      '800': {
        agentId: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath,
        tags: [],
        agentSessionId,
      },
    });
    const settings = createSettings({ '800': 'Point recovery' });
    const metadata = createMetadata({ '800': { firstMessage: 'Point recovery prompt' } });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await forkChatFileCopy({
        sourceSession: registry.getChat('800'),
        sourceChatId: '800',
        targetChatId: '801',
        truncateAfterEntryId: 'keep-entry',
        truncateAfterLine: 1,
        registry,
        settings,
        metadata,
      });

      const forked = await fs.readFile(result.nativePath, 'utf8');
      expect(JSON.parse(forked)).toMatchObject({ uuid: 'keep-entry' });
      expect(forked).not.toContain('"type":"mode"');
      expect(forked).not.toContain('drop-entry');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('fails message-point forks when the source entry id is unavailable', async () => {
    const agentSessionId = '66666666-6666-6666-6666-666666666666';
    const nativePath = path.join(tmpDir, `${agentSessionId}.jsonl`);
    const content = [
      JSON.stringify({ type: 'session', session_id: agentSessionId }),
      JSON.stringify({ type: 'message', session_id: agentSessionId, uuid: 'entry-1', text: 'keep' }),
    ].join('\n');
    await fs.writeFile(nativePath, content, 'utf8');
    const registry = createRegistry({
      '600': {
        agentId: 'claude',
        model: 'sonnet',
        projectPath: '/proj',
        nativePath,
        tags: [],
        agentSessionId,
      },
    });
    const settings = createSettings({ '600': 'Missing point fork' });
    const metadata = createMetadata({ '600': { firstMessage: 'Missing prompt' } });

    await expect(forkChatFileCopy({
      sourceSession: registry.getChat('600'),
      sourceChatId: '600',
      targetChatId: '601',
      truncateAfterEntryId: 'missing-entry',
      registry,
      settings,
      metadata,
    })).rejects.toThrow(/missing source entry missing-entry/);

    expect(registry.getChat('601')).toBeNull();
  });
});
