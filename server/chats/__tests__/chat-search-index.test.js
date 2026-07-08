import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '../../../common/chat-types.js';
import { ChatSearchIndex } from '../chat-search-index.js';

let tempDir;

function registry(sessions) {
  return {
    listAllChats: mock(() => sessions),
  };
}

describe('ChatSearchIndex', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-search-'));
  });

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function createIndex(messagesByChatId = {}) {
    const index = new ChatSearchIndex({
      dbPath: path.join(tempDir, 'search.sqlite'),
      registry: registry({
        c1: {
          agentId: 'claude',
          agentSessionId: 's1',
          nativePath: null,
          projectPath: '/tmp/project',
          tags: [],
          model: 'sonnet',
        },
        c2: {
          agentId: 'codex',
          agentSessionId: 's2',
          nativePath: null,
          projectPath: '/tmp/project',
          tags: [],
          model: 'gpt',
        },
      }),
      loadNativeMessages: mock(async (chatId) => messagesByChatId[chatId] ?? []),
      now: () => new Date('2026-07-08T00:00:00.000Z'),
    });
    await index.init();
    return index;
  }

  it('indexes normalized chat messages and returns snippets by allowed chat', async () => {
    const index = await createIndex({
      c1: [
        new UserMessage('2026-07-08T00:00:00.000Z', 'How do we rotate deployment tokens?'),
        new AssistantMessage('2026-07-08T00:01:00.000Z', 'Use the needle rotation runbook.'),
      ],
      c2: [new AssistantMessage('2026-07-08T00:00:00.000Z', 'needle belongs to another chat')],
    });

    await index.reindexStaleChats();
    const result = index.search({
      query: 'needle',
      allowedChatIds: ['c1'],
      limit: 10,
    });

    expect(result.results.map((entry) => entry.chatId)).toEqual(['c1']);
    expect(result.results[0].snippets[0].text).toContain('needle rotation runbook');
    expect(result.index).toEqual({ indexedChatCount: 1, pendingChatCount: 0 });
  });

  it('appends live tool messages and deletes removed chats', async () => {
    const index = await createIndex();
    index.appendMessages('c1', [
      new BashToolUseMessage('2026-07-08T00:00:00.000Z', 'tool-1', 'rg superneedle .'),
    ]);

    expect(index.search({ query: 'superneedle', allowedChatIds: ['c1'] }).results).toHaveLength(1);

    index.deleteChat('c1');
    expect(index.search({ query: 'superneedle', allowedChatIds: ['c1'] }).results).toEqual([]);
  });
});
