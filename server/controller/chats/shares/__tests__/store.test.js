import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { AssistantMessage, UserMessage } from '../../../../../common/chat-types.ts';
import { storedProviderRows } from '../../../ledger/__tests__/stored-rows.ts';
import { ShareStore } from '../store.js';
import { TranscriptRenderingWorker } from '../../transcript-rendering/client.ts';
import { inlineTranscriptRendering } from '../../transcript-rendering/__tests__/inline-transcript-rendering.ts';
import { withFailingDirectorySync } from '../../../../common/__tests__/atomic-write-failure.ts';

const AT = '2026-01-01T00:00:00.000Z';
let workspaceDir;

function publication(overrides = {}) {
  return {
    chatId: 'chat-1',
    title: 'Share title',
    agentId: 'codex',
    model: 'gpt-5',
    projectPath: '/workspace/garcon',
    sharedAt: AT,
    origin: { transcriptViewId: 'view-1', lastOrdinal: 1 },
    ...overrides,
  };
}

function rows(...contents) {
  return storedProviderRows(contents.map((content, index) => (
    index % 2 === 0 ? new UserMessage(AT, content) : new AssistantMessage(AT, content)
  )));
}

function createStore(rendering = inlineTranscriptRendering) {
  return new ShareStore(workspaceDir, { rendering });
}

// Renders inline, holding the next rendering after holdNext() until it is released.
function heldRendering() {
  let next = null;
  const hold = async () => {
    const current = next;
    next = null;
    if (!current) return;
    current.enter();
    await current.released;
  };
  const control = {
    publications: 0,
    rendering: {
      renderTranscriptExport: inlineTranscriptRendering.renderTranscriptExport,
      async renderShareSnapshot(input, signal) {
        control.publications += 1;
        await hold();
        return inlineTranscriptRendering.renderShareSnapshot(input, signal);
      },
      async convertShareSnapshot(shareToken, json, signal) {
        await hold();
        return inlineTranscriptRendering.convertShareSnapshot(shareToken, json, signal);
      },
    },
    holdNext() {
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      next = { enter, released };
      return { entered, release };
    },
  };
  return control;
}

async function writeDocumentSnapshot(token, overrides = {}) {
  const snapshot = legacySnapshot(token, overrides);
  await fs.mkdir(path.join(workspaceDir, 'shares'), { recursive: true });
  await writeIndex({ [token]: indexEntry(snapshot) });
  await fs.writeFile(snapshotPath(token, 'json'), JSON.stringify(snapshot));
  return snapshot;
}

function snapshotPath(token, extension = 'ndjson') {
  return path.join(workspaceDir, 'shares', `${token}.${extension}`);
}

function legacySnapshot(token, overrides = {}) {
  return {
    shareToken: token,
    ...publication(overrides),
    messages: [{ type: 'user-message', timestamp: AT, content: 'hello' }],
  };
}

async function writeIndex(shares) {
  await fs.writeFile(path.join(workspaceDir, 'shared-chats.json'), JSON.stringify({ version: 2, shares }));
}

function indexEntry(snapshot) {
  const { shareToken, chatId, title, agentId, model, projectPath, sharedAt } = snapshot;
  return { shareToken, chatId, title, agentId, model, projectPath, sharedAt };
}

async function writePersistedShareFixture(token = 'persisted-token') {
  const sharesDirectory = path.join(workspaceDir, 'shares');
  const indexPath = path.join(workspaceDir, 'shared-chats.json');
  const snapshot = legacySnapshot(token);
  const { messages, ...header } = snapshot;
  await fs.mkdir(sharesDirectory);
  await writeIndex({ [token]: indexEntry(snapshot) });
  await fs.writeFile(snapshotPath(token), [
    JSON.stringify({ ...header, messageCount: messages.length }),
    ...messages.map((message) => JSON.stringify(message)),
  ].join('\n'));
  return { token, sharesDirectory, indexPath, snapshotPath: snapshotPath(token), messages };
}

beforeEach(async () => {
  workspaceDir = path.join(os.tmpdir(), `garcon-share-store-test-${randomUUID()}`);
  await fs.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('ShareStore', () => {
  it('reads overlapping pages without loading or caching a whole snapshot', async () => {
    const store = createStore();
    await store.init();
    const created = await store.publish('chat-1', publication(), rows(
      'x'.repeat(200_000), 'first selected', 'second selected', 'y'.repeat(200_000),
    ));
    const readFile = spyOn(fs, 'readFile').mockRejectedValue(new Error('whole-file read forbidden'));
    try {
      const pages = await Promise.all([
        store.getMessages(created.shareToken, () => ({ start: 1, end: 3 })),
        store.getMessages(created.shareToken, () => ({ start: 2, end: 3 })),
      ]);
      expect(pages[0].header.messageCount).toBe(4);
      expect(pages.map(page => page.messages.map(line => JSON.parse(line).content)))
        .toEqual([['first selected', 'second selected'], ['second selected']]);
      expect(readFile).not.toHaveBeenCalled();
      await expect(store.getMessages(created.shareToken)).rejects.toThrow('whole-file read forbidden');
    } finally { readFile.mockRestore(); }
  });

  it('pages cached and legacy snapshots using the same header-qualified range', async () => {
    await writeDocumentSnapshot('legacy-page');
    const store = createStore();
    await store.init();
    const select = header => ({ start: 0, end: header.messageCount });
    expect((await store.getMessages('legacy-page', select)).messages).toHaveLength(1);
    await store.getMessages('legacy-page');
    expect((await store.getMessages('legacy-page', () => ({ start: 0, end: 0 }))).messages).toEqual([]);
  });

  it('does not cache snapshots exceeding the byte budget', async () => {
    const store = new ShareStore(workspaceDir, { rendering: inlineTranscriptRendering, cacheBytes: 1 });
    await store.init();
    const created = await store.publish('chat-1', publication(), rows('uncached'));
    await store.getMessages(created.shareToken);
    const readFile = spyOn(fs, 'readFile');
    try {
      await store.getMessages(created.shareToken);
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally { readFile.mockRestore(); }
  });

  it('evicts least recently read snapshots when their combined bytes exceed the budget', async () => {
    let now = 0;
    const store = new ShareStore(workspaceDir, { rendering: inlineTranscriptRendering, cacheBytes: 1_500, now: () => now++ });
    await store.init();
    const a = await store.publish('chat-1', publication(), rows('a'.repeat(100)));
    const b = await store.publish('chat-2', publication({ chatId: 'chat-2' }), rows('b'.repeat(100)));
    await store.getMessages(a.shareToken);
    await store.getMessages(b.shareToken);
    const readFile = spyOn(fs, 'readFile');
    try {
      await store.getMessages(b.shareToken);
      expect(readFile).not.toHaveBeenCalled();
      await store.getMessages(a.shareToken);
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally { readFile.mockRestore(); }
  });

  it('rejects paged snapshots with a truncated message count', async () => {
    const fixture = await writePersistedShareFixture();
    const store = createStore();
    await store.init();
    const original = await fs.readFile(fixture.snapshotPath, 'utf8');
    await fs.writeFile(fixture.snapshotPath, original + '\n{}');
    expect(await store.getMessages(fixture.token, () => ({ start: 0, end: 1 }))).toBeNull();
  });

  it('stores one message per line and the plain text per token, and keeps only metadata in the index', async () => {
    const store = createStore();
    await store.init();

    const created = await store.publish('chat-1', publication(), rows('hello', 'answer'));

    const indexRaw = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8'));
    expect(indexRaw.version).toBe(2);
    expect(indexRaw.shares[created.shareToken]).toEqual(indexEntry({ ...publication(), shareToken: created.shareToken }));
    const lines = (await fs.readFile(snapshotPath(created.shareToken), 'utf8')).split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ chatId: 'chat-1', messageCount: 2, origin: publication().origin });
    expect(lines.slice(1).map((line) => JSON.parse(line).content)).toEqual(['hello', 'answer']);
    const text = await fs.readFile(snapshotPath(created.shareToken, 'txt'), 'utf8');
    expect(text).toContain('Title: Share title');
    expect(text).toContain('answer');

    const fresh = createStore();
    await fresh.init();
    expect(await fresh.getHeader(created.shareToken)).toMatchObject({ title: 'Share title', messageCount: 2 });
    const shared = await fresh.getMessages(created.shareToken);
    expect(shared.messages.map((line) => JSON.parse(line).content)).toEqual(['hello', 'answer']);
    expect(fresh.getEntryByChatId('chat-1')?.shareToken).toBe(created.shareToken);
    expect(await fresh.getTextPath(created.shareToken)).toBe(snapshotPath(created.shareToken, 'txt'));
  });

  it('renders shares on the transcript rendering Worker', async () => {
    const rendering = new TranscriptRenderingWorker();
    try {
      const store = createStore(rendering);
      await store.init();

      const created = await store.publish('chat-1', publication(), rows('hello', 'answer'));

      expect((await store.getMessages(created.shareToken)).header.messageCount).toBe(2);
      expect(await fs.readFile(snapshotPath(created.shareToken, 'txt'), 'utf8')).toContain('answer');
    } finally {
      rendering.close();
    }
  });

  it('stores the share index, snapshot, and plain text with owner-only permissions', async () => {
    if (process.platform === 'win32') return;
    const store = createStore();
    await store.init();

    const created = await store.publish('chat-1', publication(), rows('hello'));

    expect((await fs.stat(path.join(workspaceDir, 'shared-chats.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(snapshotPath(created.shareToken))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(snapshotPath(created.shareToken, 'txt'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(workspaceDir, 'shares'))).mode & 0o777).toBe(0o700);
  });

  it('repairs permissions on an existing share index, directory, and snapshot', async () => {
    if (process.platform === 'win32') return;
    const fixture = await writePersistedShareFixture();
    await Promise.all([
      fs.chmod(fixture.sharesDirectory, 0o755),
      fs.chmod(fixture.indexPath, 0o644),
      fs.chmod(fixture.snapshotPath, 0o644),
    ]);

    const store = createStore();
    await store.init();
    const loaded = await store.getMessages(fixture.token);

    expect(loaded.messages.map((line) => JSON.parse(line))).toEqual(fixture.messages);
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
      const store = createStore();
      await store.init();
      const loaded = await store.getMessages(fixture.token);

      expect(loaded.messages.map((line) => JSON.parse(line))).toEqual(fixture.messages);
      expect(chmod).toHaveBeenCalledWith(fixture.sharesDirectory, 0o700);
      expect(chmod).toHaveBeenCalledWith(fixture.indexPath, 0o600);
      expect(chmod).toHaveBeenCalledWith(fixture.snapshotPath, 0o600);
    } finally {
      chmod.mockRestore();
    }
  });

  it('republishes a chat under its existing token', async () => {
    const store = createStore();
    await store.init();
    const created = await store.publish('chat-1', publication(), rows('hello'));
    await store.getMessages(created.shareToken);

    const updated = await store.publish('chat-1', publication({ title: 'Updated title' }), rows('hello', 'updated'));

    expect(updated.shareToken).toBe(created.shareToken);
    const cached = await store.getMessages(created.shareToken);
    expect(cached.header.title).toBe('Updated title');
    expect(cached.messages.map((line) => JSON.parse(line).content)).toEqual(['hello', 'updated']);
  });

  it('does not restore a share revoked while it republishes', async () => {
    const held = heldRendering();
    const store = createStore(held.rendering);
    await store.init();
    const created = await store.publish('chat-1', publication(), rows('hello'));
    const hold = held.holdNext();
    const republished = store.publish('chat-1', publication({ title: 'Updated title' }), rows('hello', 'updated'));
    await hold.entered;

    const revoked = store.revokeShareByChatId('chat-1');
    hold.release();
    await republished;

    expect(await revoked).toBe(true);
    expect(store.getEntryByChatId('chat-1')).toBeNull();
    expect(await store.getMessages(created.shareToken)).toBeNull();
    await expect(fs.access(snapshotPath(created.shareToken))).rejects.toThrow();
    const fresh = createStore();
    await fresh.init();
    expect(fresh.getEntryByChatId('chat-1')).toBeNull();
  });

  it('gives concurrent first publications of a chat one token', async () => {
    const held = heldRendering();
    const store = createStore(held.rendering);
    await store.init();
    const hold = held.holdNext();
    const first = store.publish('chat-1', publication({ title: 'First title' }), rows('first'));
    await hold.entered;

    const second = store.publish('chat-1', publication({ title: 'Second title' }), rows('second'));
    hold.release();
    const [firstEntry, secondEntry] = await Promise.all([first, second]);

    expect(secondEntry.shareToken).toBe(firstEntry.shareToken);
    const indexRaw = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8'));
    expect(Object.keys(indexRaw.shares)).toEqual([firstEntry.shareToken]);
    expect((await store.getMessages(firstEntry.shareToken)).header.title).toBe('Second title');
  });

  it('serializes different-chat index commits without exposing uncommitted publications', async () => {
    const store = createStore();
    await store.init();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const originalRename = fs.rename;
    let indexWrites = 0;
    const rename = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === path.join(workspaceDir, 'shared-chats.json') && ++indexWrites === 1) {
        entered.resolve(); await release.promise;
      }
      return originalRename(source, target);
    });
    const first = store.publish('chat-1', publication(), rows('first'));
    let second;
    try {
      await entered.promise;
      expect(store.getEntryByChatId('chat-1')).toBeNull();
      second = store.publish('chat-2', publication({ chatId: 'chat-2' }), rows('second'));
      release.resolve();
      await Promise.all([first, second]);
    } finally { release.resolve(); await Promise.allSettled([first, second]); rename.mockRestore(); }
    const restarted = createStore();
    await restarted.init();
    expect(restarted.getEntryByChatId('chat-1')).not.toBeNull();
    expect(restarted.getEntryByChatId('chat-2')).not.toBeNull();
  });

  it.each(['publish', 'revoke'])('leaves confirmed index visibility and files intact after a failed %s commit', async operation => {
    const store = createStore();
    await store.init();
    const existing = await store.publish('chat-1', publication(), rows('original'));
    const originalRename = fs.rename;
    const rename = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === path.join(workspaceDir, 'shared-chats.json')) throw new Error('Synthetic index failure');
      return originalRename(source, target);
    });
    try {
      const writing = operation === 'publish'
        ? store.publish('chat-2', publication({ chatId: 'chat-2' }), rows('new'))
        : store.revokeShareByChatId('chat-1');
      await expect(writing).rejects.toMatchObject({ renamed: false });
    } finally { rename.mockRestore(); }
    expect(store.getEntryByChatId('chat-2')).toBeNull();
    expect(store.getEntryByChatId('chat-1')).toEqual(existing);
    expect((await store.getMessages(existing.shareToken)).messages).toHaveLength(1);
    const restarted = createStore();
    await restarted.init();
    expect(restarted.getEntryByChatId('chat-2')).toBeNull();
    expect(restarted.getEntryByChatId('chat-1')).toEqual(existing);
  });

  it.each(['publish', 'revoke'])('fences reads and writes after an uncertain %s index commit', async operation => {
    const store = createStore();
    await store.init();
    const existing = await store.publish('chat-1', publication(), rows('original'));
    await expect(withFailingDirectorySync(workspaceDir, () => operation === 'publish'
      ? store.publish('chat-2', publication({ chatId: 'chat-2' }), rows('new'))
      : store.revokeShareByChatId('chat-1'))).rejects.toMatchObject({ renamed: true });
    const candidate = await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8');
    expect(() => store.getEntryByChatId('chat-1')).toThrow('durability is unknown');
    await expect(store.getMessages(existing.shareToken)).rejects.toThrow('durability is unknown');
    await expect(store.getHeader(existing.shareToken)).rejects.toThrow('durability is unknown');
    await expect(store.getTextPath(existing.shareToken)).rejects.toThrow('durability is unknown');
    await expect(store.publish('chat-3', publication({ chatId: 'chat-3' }), [])).rejects.toThrow('durability is unknown');
    await expect(store.revokeShareByChatId('chat-1')).rejects.toThrow('durability is unknown');
    expect(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8')).toBe(candidate);
    const restarted = createStore();
    await restarted.init();
    expect(restarted.getEntryByChatId(operation === 'publish' ? 'chat-2' : 'chat-1') === null).toBe(operation === 'revoke');
  });

  it('persists revocation before snapshot cleanup can fail', async () => {
    const store = createStore();
    await store.init();
    const entry = await store.publish('chat-1', publication(), rows('original'));
    const originalUnlink = fs.unlink;
    const unlink = spyOn(fs, 'unlink').mockImplementation(async target => {
      if (target === snapshotPath(entry.shareToken)) throw new Error('Synthetic cleanup failure');
      return originalUnlink(target);
    });
    try { await expect(store.revokeShareByChatId('chat-1')).rejects.toThrow('Synthetic cleanup failure'); }
    finally { unlink.mockRestore(); }
    expect(await store.getHeader(entry.shareToken)).toBeNull();
    const restarted = createStore();
    await restarted.init();
    expect(await restarted.getHeader(entry.shareToken)).toBeNull();
  });

  it('keeps a republication that lands while an older snapshot converts', async () => {
    await writeDocumentSnapshot('document-token', { title: 'Document title' });
    const held = heldRendering();
    const store = createStore(held.rendering);
    await store.init();
    const hold = held.holdNext();
    const reading = store.getMessages('document-token');
    await hold.entered;

    const republished = store.publish('chat-1', publication({ title: 'Republished title' }), rows('republished'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(held.publications).toBe(0);
    hold.release();
    await Promise.all([reading, republished]);

    const fresh = createStore();
    await fresh.init();
    const shared = await fresh.getMessages('document-token');
    expect(shared.header.title).toBe('Republished title');
    expect(shared.messages.map((line) => JSON.parse(line).content)).toEqual(['republished']);
    expect(await fs.readFile(snapshotPath('document-token', 'txt'), 'utf8')).toContain('republished');
  });

  it('converts an older snapshot again when writing its plain text failed', async () => {
    await writeDocumentSnapshot('document-token');
    await fs.mkdir(snapshotPath('document-token', 'txt'));
    const store = createStore();
    await store.init();

    await expect(store.getMessages('document-token')).rejects.toThrow();
    await fs.rm(snapshotPath('document-token', 'txt'), { recursive: true });

    expect(await store.getTextPath('document-token')).toBe(snapshotPath('document-token', 'txt'));
    expect(await fs.readFile(snapshotPath('document-token', 'txt'), 'utf8')).toContain('hello');
    expect((await store.getMessages('document-token')).messages).toHaveLength(1);
  });

  it('converts a snapshot stored as one document on its first read', async () => {
    const snapshot = await writeDocumentSnapshot('document-token', { title: 'Document title' });

    const store = createStore();
    await store.init();
    expect(await store.getHeader('document-token')).toMatchObject({ title: 'Document title', messageCount: 1 });

    const shared = await store.getMessages('document-token');
    expect(shared.messages.map((line) => JSON.parse(line))).toEqual(snapshot.messages);
    expect(await fs.readFile(snapshotPath('document-token', 'txt'), 'utf8')).toContain('hello');
    await expect(fs.access(snapshotPath('document-token', 'json'))).rejects.toThrow();
  });

  it('migrates legacy shared snapshot files into the token snapshot layout', async () => {
    await fs.writeFile(
      path.join(workspaceDir, 'shared-chats.json'),
      JSON.stringify({
        version: 1,
        shares: {
          'legacy-token': legacySnapshot('legacy-token', { chatId: 'legacy-chat', title: 'Legacy title' }),
        },
      }),
      'utf8',
    );

    const store = createStore();
    await store.init();

    const indexRaw = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8'));
    expect(indexRaw.version).toBe(2);
    expect(indexRaw.shares['legacy-token'].messages).toBeUndefined();
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(workspaceDir, 'shared-chats.json'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(snapshotPath('legacy-token', 'json'))).mode & 0o777).toBe(0o600);
    }
    const migrated = await store.getMessages('legacy-token');
    expect(migrated.header.chatId).toBe('legacy-chat');
    expect(migrated.messages).toHaveLength(1);
  });

  it('fails closed when a legacy snapshot cannot be persisted', async () => {
    const indexPath = path.join(workspaceDir, 'shared-chats.json');
    const legacyIndex = JSON.stringify({
      version: 1,
      shares: {
        'legacy-token': legacySnapshot('legacy-token', { chatId: 'legacy-chat', title: 'Legacy title' }),
      },
    });
    await fs.writeFile(indexPath, legacyIndex, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'shares'), 'not a directory', 'utf8');

    await expect(createStore().init()).rejects.toThrow();

    expect(await fs.readFile(indexPath, 'utf8')).toBe(legacyIndex);
  });

  it('forgets a share whose snapshot files are gone', async () => {
    const snapshot = legacySnapshot('missing-token');
    await fs.mkdir(path.join(workspaceDir, 'shares'));
    await writeIndex({ 'missing-token': indexEntry(snapshot) });

    const store = createStore();
    await store.init();

    expect(await store.getMessages('missing-token')).toBeNull();
    expect(store.getEntryByChatId(snapshot.chatId)).toBeNull();
  });

  it('revokes shares from the index, cache, and snapshot files', async () => {
    const store = createStore();
    await store.init();
    const created = await store.publish('chat-1', publication(), rows('hello'));

    const revoked = await store.revokeShareByChatId('chat-1');

    expect(revoked).toBe(true);
    expect(await store.getMessages(created.shareToken)).toBeNull();
    expect(await store.getTextPath(created.shareToken)).toBeNull();
    await expect(fs.access(snapshotPath(created.shareToken))).rejects.toThrow();
    await expect(fs.access(snapshotPath(created.shareToken, 'txt'))).rejects.toThrow();

    const indexRaw = JSON.parse(await fs.readFile(path.join(workspaceDir, 'shared-chats.json'), 'utf8'));
    expect(indexRaw.shares[created.shareToken]).toBeUndefined();
  });
});
