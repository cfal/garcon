import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { AssistantMessage, UserMessage } from '../../../../common/chat-types.ts';
import { storedProviderRows } from '../../ledger/__tests__/stored-rows.ts';
import { ShareStore } from '../share-store.js';
import { TranscriptRenderingWorker } from '../transcript-rendering/client.ts';
import { inlineTranscriptRendering } from '../transcript-rendering/__tests__/inline-transcript-rendering.ts';

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
