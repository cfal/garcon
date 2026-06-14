import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ChatEventLog } from '../chat-event-log.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';

let tmpDir;
let log;

function user(content, metadata = {}) {
  return new UserMessage('2026-06-01T00:00:00.000Z', content, undefined, metadata);
}

function assistant(content) {
  return new AssistantMessage('2026-06-01T00:00:01.000Z', content);
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
});
