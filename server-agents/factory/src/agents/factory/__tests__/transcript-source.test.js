import { describe, expect, it, mock } from 'bun:test';

import { UserMessage } from '@garcon/common/chat-types';
import { createFactoryTranscriptSource } from '../factory-transcript-source.js';

function createDeps(overrides = {}) {
  return {
    findSessionFileBySessionId: mock(async () => null),
    getPreviewFromSessionPath: mock(async (sessionPath) => ({ firstMessage: `path:${sessionPath}` })),
    loadFromPath: mock(async (sessionPath) => [new UserMessage('2026-03-29T00:00:00.000Z', `path:${sessionPath}`)]),
    ...overrides,
  };
}

function createSession(overrides = {}) {
  return {
    agentId: 'factory',
    projectPath: '/proj',
    ...overrides,
  };
}

describe('createFactoryTranscriptSource', () => {
  it('loads and previews real Factory native paths directly', async () => {
    const deps = createDeps();
    const source = createFactoryTranscriptSource(deps);
    const session = createSession({
      agentSessionId: 'sess-1',
      nativePath: '/tmp/factory/sess-1.jsonl',
    });

    await expect(source.loadMessages(session)).resolves.toEqual([
      new UserMessage('2026-03-29T00:00:00.000Z', 'path:/tmp/factory/sess-1.jsonl'),
    ]);
    await expect(source.getPreview?.(session)).resolves.toEqual({
      firstMessage: 'path:/tmp/factory/sess-1.jsonl',
    });
    expect(deps.loadFromPath).toHaveBeenCalledWith('/tmp/factory/sess-1.jsonl');
  });

  it('does not load Factory messages without a real native path', async () => {
    const deps = createDeps();
    const source = createFactoryTranscriptSource(deps);
    const session = createSession({
      agentSessionId: 'sess-no-path',
    });

    const messages = await source.loadMessages(session);

    expect(messages).toEqual([]);
    expect(deps.loadFromPath).not.toHaveBeenCalled();
  });

  it('resolves real paths when Droid can find the session file', async () => {
    const deps = createDeps({
      findSessionFileBySessionId: mock(async () => '/tmp/factory/sess-2.jsonl'),
    });
    const source = createFactoryTranscriptSource(deps);

    await expect(source.resolveNativePath?.(createSession({
      agentSessionId: 'sess-2',
    }))).resolves.toBe('/tmp/factory/sess-2.jsonl');
  });

  it('returns null when no Factory JSONL path is available', async () => {
    const deps = createDeps();
    const source = createFactoryTranscriptSource(deps);

    await expect(source.resolveNativePath?.(createSession({
      agentSessionId: 'sess-missing',
    }))).resolves.toBeNull();
  });
});
