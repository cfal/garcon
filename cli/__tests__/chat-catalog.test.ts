import { describe, expect, test } from 'bun:test';
import {
  buildChatCatalogResult,
  formatChatCatalogResult,
  parseCliChatFilter,
  runChatCatalog,
} from '../chat-catalog.js';
import type { ChatsCliCommand } from '../args.js';
import type { CliOutput } from '../output.js';
import { CHAT_ID, OTHER_CHAT_ID, TS, chat, chatList } from './chat-research-fixtures.js';

const command: ChatsCliCommand = {
  kind: 'chats',
  workspace: 'default',
  configDir: '/config',
  filter: 'project:/garcon tag:cli',
  limit: 1,
  offset: 0,
  json: false,
};

describe('chat catalog', () => {
  test('filters, activity-sorts, projects, and pages chats deterministically', () => {
    const older = chat({
      id: CHAT_ID,
      title: 'Older',
      activity: {
        createdAt: '2026-09-01T00:00:00.000Z',
        lastActivityAt: '2026-09-02T00:00:00.000Z',
        lastReadAt: null,
      },
    });
    const newer = chat({
      id: OTHER_CHAT_ID,
      title: 'Newer',
      activity: { ...older.activity, lastActivityAt: TS },
    });
    const excluded = chat({
      id: '1785337200123458',
      projectPath: '/other',
    });

    const result = buildChatCatalogResult(command, chatList([older, excluded, newer]));

    expect(result.page).toEqual({
      offset: 0,
      limit: 1,
      total: 2,
      hasMore: true,
      nextOffset: 1,
    });
    expect(result.chats).toEqual([expect.objectContaining({
      chatId: OTHER_CHAT_ID,
      title: 'Newer',
      projectPath: '/garcon',
      agentId: 'codex',
      tags: ['cli'],
    })]);
  });

  test('rejects known invalid filter operators instead of widening the result', () => {
    expect(() => parseCliChatFilter('status:finished project:/garcon'))
      .toThrow('invalid chat filter token: status:finished');
    expect(() => parseCliChatFilter('is:deleted'))
      .toThrow('invalid chat filter token: is:deleted');
  });

  test('applies shared direct-parent, identity, and transcript-activity date semantics', () => {
    const directChild = chat({
      id: CHAT_ID,
      parentChat: { chatId: OTHER_CHAT_ID, relation: 'delegation' },
      activity: {
        createdAt: '2026-09-01T00:00:00.000Z',
        lastActivityAt: '2026-09-03T12:00:00.000Z',
        lastReadAt: null,
      },
    });
    const unrelated = chat({
      id: '1785337200123458',
      activity: {
        createdAt: '2026-09-02T00:00:00.000Z',
        lastActivityAt: '2026-09-04T00:00:00.000Z',
        lastReadAt: null,
      },
    });

    const result = buildChatCatalogResult({
      filter: `id:${CHAT_ID} parent:${OTHER_CHAT_ID} created-before:2026-09-02 updated-after:2026-09-03`,
      limit: 20,
      offset: 0,
    }, chatList([unrelated, directChild]));

    expect(result.chats.map((value) => value.chatId)).toEqual([CHAT_ID]);
  });

  test('formats stable JSON and an unambiguous empty page', () => {
    const result = buildChatCatalogResult(
      { ...command, filter: '', offset: 10 },
      chatList([chat()]),
    );
    expect(JSON.parse(formatChatCatalogResult(result, true))).toEqual(result);
    expect(formatChatCatalogResult(result, false)).toContain('showing 0 of 1');
  });

  test('lists chats through the read-only output path', async () => {
    const values: string[] = [];
    const output = { result(value: string) { values.push(value); } } as CliOutput;
    await runChatCatalog(command, {
      async listChats() { return chatList([chat()]); },
    }, output);
    expect(values).toHaveLength(1);
    expect(values[0]).toContain(CHAT_ID);
  });
});
