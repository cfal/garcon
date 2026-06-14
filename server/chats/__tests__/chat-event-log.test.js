import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ChatEventLog } from '../chat-event-log.js';
import { ChatStreamFence } from '../chat-stream-fence.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';

let tmpDir;
let log;

function user(content, metadata = {}) {
  return new UserMessage('2026-06-01T00:00:00.000Z', content, undefined, metadata);
}

function assistant(content) {
  return new AssistantMessage('2026-06-01T00:00:01.000Z', content);
}

function persistedLine(message, overrides = {}) {
  return {
    appendSeq: overrides.appendSeq ?? 1,
    seq: overrides.seq ?? 1,
    messageId: overrides.messageId ?? `message-${Math.random().toString(36).slice(2)}`,
    rev: overrides.rev ?? 1,
    origin: overrides.origin ?? 'agent',
    message,
  };
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

describe('ChatEventLog', () => {
  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chat-event-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    log = new ChatEventLog(tmpDir, () => false, { replayLimit: 10 });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('appends messages as monotonic events and pages by sequence cursor', async () => {
    const first = await log.appendMessages('chat-1', [user('hello')], 'submit');
    const second = await log.appendMessages('chat-1', [assistant('hi')], 'agent');

    expect(first.logId).toBe(second.logId);
    expect(first.events[0]).toMatchObject({ appendSeq: 1, seq: 1, rev: 1 });
    expect(second.events[0]).toMatchObject({ appendSeq: 2, seq: 2, rev: 1 });

    const latest = await log.readPage('chat-1', 1);
    expect(latest).toMatchObject({
      logId: first.logId,
      lastAppendSeq: 2,
      pageOldestSeq: 2,
      hasMore: true,
    });
    expect(latest.events.map((event) => event.message.content)).toEqual(['hi']);

    const older = await log.readPage('chat-1', 1, latest.pageOldestSeq);
    expect(older).toMatchObject({ pageOldestSeq: 1, hasMore: false });
    expect(older.events.map((event) => event.message.content)).toEqual(['hello']);
  });

  it('revises durable user delivery without changing the stable message sequence', async () => {
    const appended = await log.appendMessages(
      'chat-1',
      [user('ship it', {
        clientRequestId: 'request-1',
        messageId: 'client-message-1',
        deliveryStatus: 'accepted',
      })],
      'submit',
    );

    const revised = await log.reviseUserMessageDelivery(
      'chat-1',
      { clientRequestId: 'request-1' },
      'delivered',
    );

    expect(revised?.logId).toBe(appended.logId);
    expect(revised?.event).toMatchObject({
      appendSeq: 2,
      seq: 1,
      messageId: appended.events[0].messageId,
      rev: 2,
    });
    expect(revised?.event.message.metadata.deliveryStatus).toBe('delivered');

    const replay = await log.readReplay('chat-1', appended.logId, 1);
    expect(replay.mode).toBe('delta');
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0].message.metadata.deliveryStatus).toBe('delivered');
  });

  it('requires a snapshot when the native generation replaces the log', async () => {
    const original = await log.appendMessages('chat-1', [user('old')], 'submit');
    const replacement = await log.replaceGenerationFromNative('chat-1', [assistant('fresh')]);

    expect(replacement.logId).not.toBe(original.logId);
    expect(replacement.events.map((event) => event.message.content)).toEqual(['fresh']);

    const replay = await log.readReplay('chat-1', original.logId, original.events[0].appendSeq);
    expect(replay).toMatchObject({
      logId: replacement.logId,
      mode: 'snapshot-required',
      events: [],
      lastAppendSeq: 1,
    });
  });

  it('reloads persisted events to identical visible state across instances', async () => {
    const first = new ChatEventLog(tmpDir, () => false);
    await first.appendMessages('chat-1', [user('A'), assistant('B')], 'agent');

    const second = new ChatEventLog(tmpDir, () => false);
    const page = await second.readPage('chat-1', 10);

    expect(page.events.map((event) => event.message.content)).toEqual(['A', 'B']);
    expect(page.lastAppendSeq).toBe(2);
  });

  it('replays a revision of an old message after the client cursor', async () => {
    const appended = await log.appendMessages('chat-1', [
      user('A', { clientRequestId: 'req-A', deliveryStatus: 'accepted' }),
      assistant('B'),
      assistant('C'),
      assistant('D'),
    ], 'agent');

    const revised = await log.reviseUserMessageDelivery('chat-1', { clientRequestId: 'req-A' }, 'delivered');
    const replay = await log.readReplay('chat-1', appended.logId, 4);

    expect(revised.event.seq).toBe(1);
    expect(replay.mode).toBe('delta');
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({
      seq: 1,
      appendSeq: 5,
      rev: 2,
    });
  });

  it('returns snapshot-required for stale logId, client-ahead cursor, and replay gaps', async () => {
    const appended = await log.appendMessages('chat-1', [user('one'), assistant('two')], 'agent');

    await expect(log.readReplay('chat-1', 'stale-log', 1)).resolves.toMatchObject({
      mode: 'snapshot-required',
      logId: appended.logId,
    });

    await expect(log.readReplay('chat-1', appended.logId, 999)).resolves.toMatchObject({
      mode: 'snapshot-required',
      logId: appended.logId,
    });

    const tiny = new ChatEventLog(tmpDir, () => false, { replayLimit: 1 });
    await tiny.appendMessages('chat-2', [user('A'), assistant('B'), assistant('C')], 'agent');
    const page = await tiny.readPage('chat-2', 10);

    await expect(tiny.readReplay('chat-2', page.logId, 1)).resolves.toMatchObject({
      mode: 'snapshot-required',
      logId: page.logId,
    });
  });

  it('drops corrupt persisted tail from the first bad line', async () => {
    const appended = await log.appendMessages('chat-1', [user('valid')], 'submit');
    const filePath = path.join(tmpDir, 'chat-events', 'chat-1.events.jsonl');
    await fs.appendFile(
      filePath,
      '{not valid json}\n'
        + JSON.stringify(persistedLine(assistant('after corrupt'), {
          appendSeq: appended.events[0].appendSeq + 1,
          seq: appended.events[0].seq + 1,
        }))
        + '\n',
    );

    const fresh = new ChatEventLog(tmpDir, () => false);
    const page = await fresh.readPage('chat-1', 10);

    expect(page.events.map((event) => event.message.content)).toEqual(['valid']);
    expect(page.lastAppendSeq).toBe(1);
  });

  it('serializes concurrent appends into gap-free appendSeq values', async () => {
    const writes = Array.from({ length: 25 }, (_, index) =>
      log.appendMessages('chat-1', [assistant(`message ${index}`)], 'agent'));

    await Promise.all(writes);
    const page = await log.readPage('chat-1', 100);

    expect(page.events.map((event) => event.appendSeq)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it('does not mutate memory when append persistence fails', async () => {
    const brokenWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-event-log-broken-'));
    const broken = new ChatEventLog(brokenWorkspace, () => false);

    try {
      await broken.readPage('chat-1', 10);
      await fs.writeFile(path.join(brokenWorkspace, 'chat-events'), 'not a directory');
      await expect(broken.appendMessages('chat-1', [user('lost')], 'submit')).rejects.toThrow();
      expect(broken.getLoadedMessages('chat-1')).toEqual([]);
    } finally {
      await fs.rm(brokenWorkspace, { recursive: true, force: true });
    }
  });

  it('does not replace memory when native replacement persistence fails', async () => {
    const brokenWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-event-log-replace-broken-'));
    await fs.writeFile(path.join(brokenWorkspace, 'chat-events'), 'not a directory');
    const broken = new ChatEventLog(brokenWorkspace, () => false);

    try {
      await expect(broken.replaceGenerationFromNative('chat-1', [assistant('native')])).rejects.toThrow();
      expect(broken.getLoadedMessages('chat-1')).toBeNull();
    } finally {
      await fs.rm(brokenWorkspace, { recursive: true, force: true });
    }
  });

  it('deleteChatLog removes memory and the persisted file', async () => {
    await log.appendMessages('chat-1', [user('delete me')], 'submit');
    const filePath = path.join(tmpDir, 'chat-events', 'chat-1.events.jsonl');
    expect(await fileExists(filePath)).toBe(true);

    await log.deleteChatLog('chat-1');
    const page = await log.readPage('chat-1', 10);

    expect(page.events).toEqual([]);
    expect(await fileExists(filePath)).toBe(false);
  });

  it('honors append guards inside the mutation lock', async () => {
    const first = await log.appendMessages('chat-1', [user('before')], 'submit');
    const skipped = await log.appendMessages('chat-1', [assistant('stale')], 'agent', {
      guard: () => false,
    });

    expect(skipped.skipped).toBe(true);
    expect(skipped.logId).toBe(first.logId);

    const page = await log.readPage('chat-1', 10);
    expect(page.events.map((event) => event.message.content)).toEqual(['before']);
    expect(page.lastAppendSeq).toBe(1);
  });

  it('allows native generation replacement while normal append mutations are backpressured', async () => {
    const smallLog = new ChatEventLog(tmpDir, () => false, {
      maxPendingMutationsPerChat: 0,
    });

    await expect(
      smallLog.appendMessages('chat-1', [assistant('rejected')], 'agent'),
    ).rejects.toThrow('mutation queue is full');

    const replacement = await smallLog.replaceGenerationFromNative('chat-1', [assistant('native')]);

    expect(replacement.events.map((event) => event.message.content)).toEqual(['native']);
    const page = await smallLog.readPage('chat-1', 10);
    expect(page.events.map((event) => event.message.content)).toEqual(['native']);
  });

  it('drops stale warm output after a process-error generation replacement', async () => {
    const fence = new ChatStreamFence();
    const epoch = fence.capture('chat-1');

    fence.invalidate('chat-1');
    await log.replaceGenerationFromNative('chat-1', [assistant('native')]);
    const stale = await log.appendMessages('chat-1', [assistant('late warm output')], 'agent', {
      guard: () => fence.isCurrent('chat-1', epoch),
    });

    expect(stale.skipped).toBe(true);
    const page = await log.readPage('chat-1', 10);
    expect(page.events.map((event) => event.message.content)).toEqual(['native']);
  });
});
