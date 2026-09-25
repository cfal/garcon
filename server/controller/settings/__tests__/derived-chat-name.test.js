import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../store.js';

let workspaceDir;
let settings;
let chatIds;
let firstMessages;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-derived-chat-name-'));
  settings = new SettingsStore(workspaceDir);
  await settings.init();
  chatIds = new Set(['source', 'target']);
  firstMessages = new Map();
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

function nameChild(chatId = 'target', sourceChatId = 'source') {
  return settings.setDerivedSessionName({
    chatId,
    sourceChatId,
    registry: { listChatIds: () => [...chatIds] },
    metadata: {
      getChatMetadata: (id) => ({ firstMessage: firstMessages.get(id) }),
    },
  });
}

describe('derived chat names', () => {
  it.each([
    ['Custom title', 'Original prompt', 'Custom title (1)'],
    [null, 'Original prompt\nMore context', 'Original prompt (1)'],
    ['  Custom title\nMore context', 'Original prompt', 'Custom title (1)'],
    [null, null, 'New Session (1)'],
    [null, '\nMore context', 'New Session (1)'],
    ['Topic (1)', null, 'Topic (1) (1)'],
  ])('suffixes the visible source title %j / %j', async (name, firstMessage, expected) => {
    if (name) await settings.setSessionName('source', name);
    firstMessages.set('source', firstMessage);

    expect(await nameChild()).toBe(expected);
    expect(settings.getChatName('target')).toBe(expected);
    const reloaded = new SettingsStore(workspaceDir);
    await reloaded.init();
    expect(reloaded.getChatName('target')).toBe(expected);
  });

  it('skips visible names across all chats and reuses gaps', async () => {
    await settings.setSessionName('source', 'Topic');
    chatIds.add('renamed');
    chatIds.add('fallback');
    chatIds.add('later');
    await settings.setSessionName('renamed', 'Topic (1)');
    firstMessages.set('fallback', 'Topic (2)\nMore context');
    await settings.setSessionName('later', 'Topic (4)');
    await settings.setSessionName('deleted', 'Topic (3)');

    expect(await nameChild()).toBe('Topic (3)');
  });

  it('reuses a deleted child name without changing the source', async () => {
    await settings.setSessionName('source', 'Topic');
    expect(await nameChild()).toBe('Topic (1)');
    chatIds.delete('target');
    await settings.removeSessionName('target');
    chatIds.add('replacement');

    expect(await nameChild('replacement')).toBe('Topic (1)');
    expect(settings.getChatName('source')).toBe('Topic');
  });

  it('serializes allocation across different source chats with the same title', async () => {
    chatIds.add('other-source');
    chatIds.add('other-target');
    await settings.setSessionName('source', 'Topic');
    await settings.setSessionName('other-source', 'Topic');

    expect(await Promise.all([
      nameChild(),
      nameChild('other-target', 'other-source'),
    ])).toEqual(['Topic (1)', 'Topic (2)']);
  });

  it('reads source renames and occupied names after earlier queued writes', async () => {
    chatIds.add('occupied');
    await settings.setSessionName('source', 'Original');
    const rename = settings.setSessionName('source', 'Renamed');
    const occupy = settings.setSessionName('occupied', 'Renamed (1)');
    const child = nameChild();

    await Promise.all([rename, occupy]);
    expect(await child).toBe('Renamed (2)');
  });
});
