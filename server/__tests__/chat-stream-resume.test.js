import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ChatEventLog } from '../chats/chat-event-log.js';
import { ChatNativeReloader } from '../chats/chat-native-reload.js';
import { ChatStreamFence } from '../chats/chat-stream-fence.js';
import { PendingUserInputService } from '../chats/pending-user-input-service.js';
import {
  ChatEventsMessage,
  ChatGenerationResetMessage,
  AgentRunFailedMessage,
} from '../../common/ws-events.ts';
import { AssistantMessage, UserMessage } from '../../common/chat-types.js';

let tmpDir;

function user(content, metadata = {}) {
  return new UserMessage('2026-06-01T00:00:00.000Z', content, undefined, metadata);
}

function assistant(content) {
  return new AssistantMessage('2026-06-01T00:00:01.000Z', content);
}

async function createResumeHarness() {
  const chatEventLog = new ChatEventLog(tmpDir, () => false);
  const broadcasts = [];
  const broadcast = (message) => broadcasts.push(message);

  return {
    chatEventLog,
    broadcasts,
    async submit(chatId, content, metadata = {}) {
      return chatEventLog.appendMessages(chatId, [user(content, metadata)], 'submit');
    },
    async emitMessages(chatId, messages, metadata = {}) {
      const appended = await chatEventLog.appendMessages(chatId, messages, 'agent');
      broadcast(new ChatEventsMessage(
        chatId,
        appended.logId,
        appended.events,
        metadata.turnId,
        metadata.clientRequestId,
      ));
      return appended;
    },
    async finish(chatId, metadata = {}) {
      const revised = await chatEventLog.reviseUserMessageDelivery(
        chatId,
        { clientRequestId: metadata.clientRequestId, turnId: metadata.turnId },
        'delivered',
      );
      if (revised) {
        broadcast(new ChatEventsMessage(chatId, revised.logId, [revised.event], metadata.turnId, metadata.clientRequestId));
      }
      return revised;
    },
    readCursor(appended) {
      return {
        logId: appended.logId,
        lastAppendSeq: appended.events.at(-1)?.appendSeq ?? 0,
      };
    },
    subscribe(chatId, cursor) {
      return chatEventLog.readReplay(chatId, cursor.logId, cursor.lastAppendSeq);
    },
  };
}

describe('chat stream resume integration', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-stream-resume-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('replays missed output and delivery revisions after reconnect', async () => {
    const app = await createResumeHarness();
    const turn = { clientRequestId: 'req-1', turnId: 'turn-1' };

    await app.submit('chat-1', 'hello', { ...turn, deliveryStatus: 'accepted' });
    const first = await app.emitMessages('chat-1', [assistant('first')], turn);
    const cursor = app.readCursor(first);

    await app.emitMessages('chat-1', [assistant('missed')], turn);
    await app.finish('chat-1', turn);

    const replay = await app.subscribe('chat-1', cursor);

    expect(replay.mode).toBe('delta');
    expect(replay.events.map((event) => event.message.content)).toContain('missed');
    expect(replay.events.some((event) => event.seq === 1 && event.rev === 2)).toBe(true);
    expect(replay.lastAppendSeq).toBe(4);
  });

  it('process failure reload resets generation and prevents stale late output', async () => {
    const chatEventLog = new ChatEventLog(tmpDir, () => false);
    const streamFence = new ChatStreamFence();
    const nativeReloader = new ChatNativeReloader(
      chatEventLog,
      { loadNativeMessages: async () => [assistant('last native message')] },
      () => true,
    );
    const pendingInputs = new PendingUserInputService({
      async ensureLoaded(chatId) {
        await nativeReloader.ensureColdLoaded(chatId);
        return chatEventLog.getMessages(chatId);
      },
      getMessages(chatId) {
        return chatEventLog.getLoadedMessages(chatId);
      },
    });
    const broadcasts = [];
    const turn = { clientRequestId: 'req-1', turnId: 'turn-1' };

    await pendingInputs.register('chat-1', 'lost prompt', turn);
    const staleEpoch = streamFence.capture('chat-1');

    streamFence.invalidate('chat-1');
    const reload = await nativeReloader.reloadFromNative('chat-1', 'process-error');
    pendingInputs.discardChat('chat-1');
    broadcasts.push(new ChatGenerationResetMessage(
      'chat-1',
      reload.logId,
      reload.events,
      reload.lastAppendSeq,
      reload.localNotice,
    ));
    broadcasts.push(new AgentRunFailedMessage('chat-1', 'process died', turn.turnId, turn.clientRequestId));

    const late = await chatEventLog.appendMessages('chat-1', [assistant('late')], 'agent', {
      guard: () => streamFence.isCurrent('chat-1', staleEpoch),
    });

    const page = await chatEventLog.readPage('chat-1', 100);
    expect(late.skipped).toBe(true);
    expect(page.events.map((event) => event.message.content)).toEqual(['last native message']);
    expect(pendingInputs.listForChat('chat-1')).toEqual([]);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'chat-generation-reset',
      localNotice: 'The process died.',
    }));
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'agent-run-failed',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    }));
  });
});
