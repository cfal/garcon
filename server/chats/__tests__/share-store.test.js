import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { ShareStore } from '../share-store.js';

let workspaceDir;

function sharePartial(overrides = {}) {
  return {
    chatId: 'chat-1',
    title: 'Share title',
    agentId: 'codex',
    model: 'gpt-5',
    projectPath: '/workspace/garcon',
    sharedAt: '2026-01-01T00:00:00.000Z',
    messages: [
      { type: 'user-message', timestamp: '2026-01-01T00:00:00.000Z', content: 'hello' },
    ],
    ...overrides,
  };
}

beforeEach(async () => {
  workspaceDir = path.join(os.tmpdir(), `garcon-share-store-test-${randomUUID()}`);
  await fs.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('ShareStore', () => {
  it('stores snapshots per token and keeps only metadata in the index', async () => {
    const store = new ShareStore(workspaceDir);
    await store.init();

    const created = await store.createShare('chat-1', sharePartial());

    const indexRaw = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8'));
    expect(indexRaw.version).toBe(2);
    expect(indexRaw.shares[created.shareToken].messages).toBeUndefined();
    expect(indexRaw.shares[created.shareToken]).toMatchObject({
      chatId: 'chat-1',
      title: 'Share title',
    });

    const snapshotRaw = JSON.parse(await fs.readFile(
      path.join(workspaceDir, 'shares', `${created.shareToken}.json`),
      'utf8',
    ));
    expect(snapshotRaw.messages).toHaveLength(1);

    const fresh = new ShareStore(workspaceDir);
    await fresh.init();
    const loaded = await fresh.getShare(created.shareToken);
    const byChat = await fresh.getShareByChatId('chat-1');

    expect(loaded?.messages).toEqual(created.messages);
    expect(byChat?.shareToken).toBe(created.shareToken);
  });

  it('updates existing share snapshots without changing the token', async () => {
    const store = new ShareStore(workspaceDir);
    await store.init();
    const created = await store.createShare('chat-1', sharePartial());

    const updated = await store.updateShare('chat-1', sharePartial({
      title: 'Updated title',
      messages: [
        { type: 'assistant-message', timestamp: '2026-01-01T00:00:01.000Z', content: 'updated' },
      ],
    }));

    expect(updated.shareToken).toBe(created.shareToken);

    const fresh = new ShareStore(workspaceDir);
    await fresh.init();
    const loaded = await fresh.getShare(created.shareToken);

    expect(loaded?.title).toBe('Updated title');
    expect(loaded?.messages).toEqual(updated.messages);
  });

  it('migrates legacy shared snapshot files into the token snapshot layout', async () => {
    await fs.writeFile(
      path.join(workspaceDir, 'shared-chats.json'),
      JSON.stringify({
        version: 1,
        shares: {
          'legacy-token': {
            shareToken: 'legacy-token',
            ...sharePartial({ chatId: 'legacy-chat', title: 'Legacy title' }),
          },
        },
      }),
      'utf8',
    );

    const store = new ShareStore(workspaceDir);
    await store.init();

    const migrated = await store.getShare('legacy-token');
    const indexRaw = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8'));
    const snapshotRaw = JSON.parse(await fs.readFile(
      path.join(workspaceDir, 'shares', 'legacy-token.json'),
      'utf8',
    ));

    expect(indexRaw.version).toBe(2);
    expect(indexRaw.shares['legacy-token'].messages).toBeUndefined();
    expect(snapshotRaw.messages).toHaveLength(1);
    expect(migrated?.chatId).toBe('legacy-chat');
  });

  it('revokes shares from the index, cache, and snapshot file', async () => {
    const store = new ShareStore(workspaceDir);
    await store.init();
    const created = await store.createShare('chat-1', sharePartial());

    const revoked = await store.revokeShareByChatId('chat-1');

    expect(revoked).toBe(true);
    expect(await store.getShare(created.shareToken)).toBeNull();
    await expect(fs.access(path.join(workspaceDir, 'shares', `${created.shareToken}.json`)))
      .rejects.toThrow();

    const indexRaw = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8'));
    expect(indexRaw.shares[created.shareToken]).toBeUndefined();
  });
});
