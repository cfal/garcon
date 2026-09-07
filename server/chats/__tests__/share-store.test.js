import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
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

async function writePersistedShareFixture(token = 'persisted-token') {
  const sharesDirectory = path.join(workspaceDir, 'shares');
  const indexPath = path.join(workspaceDir, 'shared-chats.json');
  const snapshotPath = path.join(sharesDirectory, `${token}.json`);
  const snapshot = { shareToken: token, ...sharePartial() };
  const indexEntry = {
    shareToken: token,
    chatId: snapshot.chatId,
    title: snapshot.title,
    agentId: snapshot.agentId,
    model: snapshot.model,
    projectPath: snapshot.projectPath,
    sharedAt: snapshot.sharedAt,
  };
  await fs.mkdir(sharesDirectory);
  await fs.writeFile(indexPath, JSON.stringify({
    version: 2,
    shares: { [token]: indexEntry },
  }));
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  return { token, sharesDirectory, indexPath, snapshotPath, snapshot };
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

  it('stores the share index and snapshots with owner-only permissions', async () => {
    if (process.platform === 'win32') return;
    const store = new ShareStore(workspaceDir);
    await store.init();

    const created = await store.createShare('chat-1', sharePartial());

    const indexMode = (await fs.stat(path.join(workspaceDir, 'shared-chats.json'))).mode & 0o777;
    const snapshotMode = (await fs.stat(
      path.join(workspaceDir, 'shares', `${created.shareToken}.json`),
    )).mode & 0o777;
    const sharesDirectoryMode = (await fs.stat(path.join(workspaceDir, 'shares'))).mode & 0o777;
    expect(indexMode).toBe(0o600);
    expect(snapshotMode).toBe(0o600);
    expect(sharesDirectoryMode).toBe(0o700);
  });

  it('repairs permissions on an existing share index, directory, and snapshot', async () => {
    if (process.platform === 'win32') return;
    const fixture = await writePersistedShareFixture();
    await Promise.all([
      fs.chmod(fixture.sharesDirectory, 0o755),
      fs.chmod(fixture.indexPath, 0o644),
      fs.chmod(fixture.snapshotPath, 0o644),
    ]);

    const store = new ShareStore(workspaceDir);
    await store.init();
    const loaded = await store.getShare(fixture.token);

    expect(loaded?.messages).toEqual(fixture.snapshot.messages);
    expect((await fs.stat(fixture.sharesDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(fixture.indexPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(fixture.snapshotPath)).mode & 0o777).toBe(0o600);
  });

  it('loads existing shares when permission repair fails', async () => {
    if (process.platform === 'win32') return;
    const fixture = await writePersistedShareFixture();
    const chmod = spyOn(fs, 'chmod').mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'EPERM' }),
    );

    try {
      const store = new ShareStore(workspaceDir);
      await store.init();
      const loaded = await store.getShare(fixture.token);

      expect(loaded?.messages).toEqual(fixture.snapshot.messages);
      expect(chmod).toHaveBeenCalledWith(fixture.sharesDirectory, 0o700);
      expect(chmod).toHaveBeenCalledWith(fixture.indexPath, 0o600);
      expect(chmod).toHaveBeenCalledWith(fixture.snapshotPath, 0o600);
    } finally {
      chmod.mockRestore();
    }
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
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(workspaceDir, 'shared-chats.json'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(workspaceDir, 'shares', 'legacy-token.json'))).mode & 0o777)
        .toBe(0o600);
    }
  });

  it('fails closed when a legacy snapshot cannot be persisted', async () => {
    const indexPath = path.join(workspaceDir, 'shared-chats.json');
    const legacyIndex = JSON.stringify({
      version: 1,
      shares: {
        'legacy-token': {
          shareToken: 'legacy-token',
          ...sharePartial({ chatId: 'legacy-chat', title: 'Legacy title' }),
        },
      },
    });
    await fs.writeFile(indexPath, legacyIndex, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'shares'), 'not a directory', 'utf8');

    await expect(new ShareStore(workspaceDir).init()).rejects.toThrow();

    expect(await fs.readFile(indexPath, 'utf8')).toBe(legacyIndex);
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
