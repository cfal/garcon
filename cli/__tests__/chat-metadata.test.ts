import { describe, expect, test } from 'bun:test';
import type {
  SetChatArchivedRequest,
  SetChatPinnedRequest,
} from '@garcon/common/chat-order-contracts';
import type { CliConnectionOptions } from '../args.js';
import {
  runChatOrderMutation,
  runRename,
  runSetTags,
  type ChatMetadataClient,
} from '../chat-metadata.js';
import type { CliOutput } from '../output.js';

const CHAT_ID = '1785337200123456';
const connection: CliConnectionOptions = { workspace: 'default', configDir: '/config' };

function captureOutput(): CliOutput & { readonly results: string[] } {
  const results: string[] = [];
  return {
    results,
    accepted() {},
    completed() {},
    diagnostic() {},
    result(value) { results.push(value); },
    sent() {},
    stopped() {},
  };
}

function client(): ChatMetadataClient & {
  readonly pinned: SetChatPinnedRequest[];
  readonly archived: SetChatArchivedRequest[];
} {
  const pinned: SetChatPinnedRequest[] = [];
  const archived: SetChatArchivedRequest[] = [];
  return {
    pinned,
    archived,
    async setChatPinned(request) {
      pinned.push(request);
      return {
        chatId: request.chatId,
        orderGroup: request.isPinned ? 'pinned' : 'normal',
        isPinned: request.isPinned,
        isArchived: false,
        changed: pinned.length === 1,
      };
    },
    async setChatArchived(request) {
      archived.push(request);
      return {
        chatId: request.chatId,
        orderGroup: request.isArchived ? 'archived' : 'normal',
        isPinned: false,
        isArchived: request.isArchived,
        changed: archived.length === 1,
      };
    },
    async updateChatTitle(request) {
      return { success: true, chatId: request.chatId, title: request.title, changed: false };
    },
    async setChatTags(request) {
      return { success: true, chatId: request.chatId, tags: request.tags, changed: false };
    },
  };
}

describe('chat metadata commands', () => {
  test('repeated lifecycle commands submit the same desired state', async () => {
    const api = client();
    const output = captureOutput();
    const pin = { ...connection, kind: 'pin' as const, chatId: CHAT_ID, json: true };
    await runChatOrderMutation(pin, api, output);
    await runChatOrderMutation(pin, api, output);
    await runChatOrderMutation(
      { ...connection, kind: 'unarchive', chatId: CHAT_ID, json: true },
      api,
      output,
    );

    expect(api.pinned).toEqual([
      { chatId: CHAT_ID, isPinned: true },
      { chatId: CHAT_ID, isPinned: true },
    ]);
    expect(api.archived).toEqual([{ chatId: CHAT_ID, isArchived: false }]);
    expect(output.results.map((value) => JSON.parse(value).changed)).toEqual([true, false, true]);
  });

  test('rename and set-tags use complete desired values without creation-tag policy', async () => {
    const api = client();
    const output = captureOutput();
    await runRename({
      ...connection,
      kind: 'rename',
      chatId: CHAT_ID,
      title: 'Exact title',
      json: true,
    }, api, output);
    await runSetTags({
      ...connection,
      kind: 'set-tags',
      chatId: CHAT_ID,
      tags: ['cli', 'review'],
      json: true,
    }, api, output);

    expect(JSON.parse(output.results[0]!)).toEqual({
      success: true,
      chatId: CHAT_ID,
      title: 'Exact title',
      changed: false,
    });
    expect(JSON.parse(output.results[1]!)).toEqual({
      success: true,
      chatId: CHAT_ID,
      tags: ['cli', 'review'],
      changed: false,
    });
  });
});
