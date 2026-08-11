import { describe, expect, it, mock } from 'bun:test';
import { UserMessage } from '../../../common/chat-types.js';
import { createNativeSeedReceipt } from '../../../common/transcript-seed.js';
import { OrderedChatTranscriptReader } from '../ordered-chat-transcript-reader.js';

const timestamp = '2026-08-07T00:00:00.000Z';
const segmentId = '11111111-1111-4111-8111-111111111111';

function user(content) {
  return new UserMessage(timestamp, content);
}

function chat(overrides = {}) {
  return {
    agentId: 'claude',
    nativeSession: null,
    agentOwnershipEpoch: 'epoch-1',
    agentSettingsById: {},
    projectPath: '/workspace',
    tags: [],
    agentSessionId: 'native-1',
    model: 'model-1',
    permissionMode: 'default',
    thinkingMode: 'none',
    carryOverSegments: [{
      id: segmentId,
      agentId: 'codex',
      model: 'model-0',
      capturedAt: timestamp,
      storedMessageCount: 3,
      visibleMessageCount: 3,
      trailingHandoff: { agentId: 'claude', model: 'model-1' },
    }],
    nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null,
    ...overrides,
  };
}

function nativePage(messages, limit, offset, revision = 'native-r1') {
  const end = Math.max(0, messages.length - offset);
  const start = Math.max(0, end - limit);
  return {
    messages: messages.slice(start, end),
    total: messages.length,
    hasMore: start > 0,
    offset,
    limit,
    revision,
  };
}

function fixture(options = {}) {
  const entry = options.entry ?? chat();
  const archived = options.archived ?? [user('a1'), user('a2'), user('a3')];
  const native = options.native ?? [user('n1'), user('n2'), user('n3'), user('n4')];
  const loadArchivedPage = mock(async ({ offset, limit }) => ({
    messages: archived.slice(offset, offset + limit),
  }));
  const loadNativePage = options.loadNativePage ?? mock(async (_entry, limit, offset) => (
    nativePage(native, limit, offset)
  ));
  const loadNativeSnapshot = mock(async () => ({ messages: native, revision: 'native-r1' }));
  const reader = new OrderedChatTranscriptReader({
    registry: { getChat: () => entry },
    agents: {
      loadTranscriptSnapshot: loadNativeSnapshot,
      loadMessagePage: loadNativePage,
    },
    carryOver: {
      revision: (refs) => refs.length > 0 ? `carry-v5:${refs[0].id}` : 'carry-v1:0',
      logicalMessageCount: async () => archived.length,
      loadAll: async () => archived,
      loadPage: loadArchivedPage,
    },
  });
  return {
    reader,
    entry,
    archived,
    native,
    loadArchivedPage,
    loadNativePage,
    loadNativeSnapshot,
  };
}

describe('OrderedChatTranscriptReader', () => {
  it('keeps native paging enabled while translating composite offsets', async () => {
    const { reader, loadArchivedPage, loadNativePage, loadNativeSnapshot } = fixture();

    const latest = await reader.loadPage('chat-1', 3, 0);
    expect(latest.messages.map((message) => message.content)).toEqual(['n2', 'n3', 'n4']);
    expect(latest.total).toBe(7);
    expect(loadArchivedPage).not.toHaveBeenCalled();

    const spanning = await reader.loadPage('chat-1', 4, 2);
    expect(spanning.messages.map((message) => message.content)).toEqual([
      'a2',
      'a3',
      'n1',
      'n2',
    ]);
    expect(loadArchivedPage).toHaveBeenCalledWith(expect.objectContaining({
      offset: 1,
      limit: 2,
    }));
    expect(loadNativePage).toHaveBeenCalledTimes(2);
    expect(loadNativeSnapshot).not.toHaveBeenCalled();
  });

  it('uses one composite revision for full and paged reads', async () => {
    const { reader } = fixture();

    const full = await reader.loadAll('chat-1');
    const page = await reader.loadPage('chat-1', 2, 0);

    expect(page.compositeRevision).toBe(full.compositeRevision);
    expect(page.carryOverRevision).toBe(full.carryOverRevision);
    expect(page.agentOwnershipEpoch).toBe(full.agentOwnershipEpoch);
  });

  it('returns one complete fallback snapshot and slices it for composite paging', async () => {
    const loadNativePage = mock(async () => null);
    const { reader, native, loadNativeSnapshot } = fixture({ loadNativePage });

    const window = await reader.loadNativeWindow({
      chatId: 'chat-1',
      limit: 2,
      offsetFromNewest: 1,
      signal: new AbortController().signal,
    });
    const page = await reader.loadPage('chat-1', 2, 1);

    expect(window).toMatchObject({
      kind: 'snapshot',
      messages: native,
      totalNativeMessages: native.length,
      offsetFromNewest: 0,
    });
    expect(page.messages.map((message) => message.content)).toEqual(['n2', 'n3']);
    expect(loadNativeSnapshot).toHaveBeenCalledTimes(2);
  });

  it('sanitizes only the native window that reaches the first recorded prompt', async () => {
    const prefix = '<carried-context version="2">\n  <instructions>Prior context</instructions>\n'
      + '  <transcript>\n    <user>summary</user>\n  </transcript>\n</carried-context>\n\n';
    const entry = chat({
      nativeSeedReceipt: createNativeSeedReceipt({
        agentSessionId: 'native-1',
        placement: 'user-prefix',
        prefix,
      }),
    });
    const native = [
      user(`${prefix}first prompt`),
      user('reply 1'),
      user('reply 2'),
      user('reply 3'),
    ];
    const { reader } = fixture({ entry, native });

    const latest = await reader.loadNativeWindow({
      chatId: 'chat-1',
      limit: 2,
      signal: new AbortController().signal,
    });
    const oldest = await reader.loadNativeWindow({
      chatId: 'chat-1',
      limit: 2,
      offsetFromNewest: 2,
      signal: new AbortController().signal,
    });

    expect(latest.messages.map((message) => message.content)).toEqual(['reply 2', 'reply 3']);
    expect(oldest.messages.map((message) => message.content)).toEqual([
      'first prompt',
      'reply 1',
    ]);
  });

  it('rejects a mixed read when ownership changes inside a provider page load', async () => {
    const fixtureState = fixture();
    fixtureState.loadNativePage.mockImplementationOnce(async (_entry, limit, offset) => {
      fixtureState.entry.agentOwnershipEpoch = 'epoch-2';
      return nativePage(fixtureState.native, limit, offset);
    });

    await expect(fixtureState.reader.loadNativeWindow({
      chatId: 'chat-1',
      limit: 2,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'SOURCE_REVISION_CHANGED' });
  });

});
