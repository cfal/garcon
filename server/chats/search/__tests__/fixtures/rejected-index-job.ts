import assert from 'node:assert/strict';
import { TranscriptSearchController } from '../../controller.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const failedJob = deferred();
const sameChatContinued = deferred();
const otherChatContinued = deferred();
const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason);
};
process.on('unhandledRejection', onUnhandledRejection);
let rejectNextReplacement = false;
let observeContinuation = false;

const service = {
  setResyncHandler() {},
  async enable() {},
  async replaceChat({ chatId }: { chatId: string }) {
    if (rejectNextReplacement && chatId === 'chat-1') {
      rejectNextReplacement = false;
      failedJob.resolve();
      throw new Error('index unavailable');
    }
    if (observeContinuation && chatId === 'chat-1') sameChatContinued.resolve();
    if (observeContinuation && chatId === 'chat-2') otherChatContinued.resolve();
  },
  async appendRows() {},
  async deleteChat() {},
  async pruneChats() {},
  async search() {
    return {
      results: [],
      index: {
        indexedChatCount: 0,
        pendingChatCount: 0,
        failedChatCount: 0,
        unsupportedChatCount: 0,
      },
    };
  },
  async disableAndDelete() {},
  async close() {},
};

const controller = new TranscriptSearchController({
  listChatIds: () => ['chat-1', 'chat-2'],
  ledger: {
    currentView: (chatId: string) => ({ viewId: `view-${chatId}`, contentStartOrdinal: 1 }),
    currentRows: () => [],
    subscribe: () => () => {},
  },
  service,
});

await controller.initialize(true);
observeContinuation = true;
rejectNextReplacement = true;
controller.sourceMayHaveChanged('chat-1');
await failedJob.promise;
controller.sourceMayHaveChanged('chat-1');
controller.sourceMayHaveChanged('chat-2');
await Promise.all([sameChatContinued.promise, otherChatContinued.promise]);
await Bun.sleep(0);
await controller.close();
process.off('unhandledRejection', onUnhandledRejection);

assert.deepEqual(unhandledRejections, []);
