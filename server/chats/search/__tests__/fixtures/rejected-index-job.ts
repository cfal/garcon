import { TranscriptSearchController } from '../../controller.ts';

let rejectReplacement = false;

const service = {
  setResyncHandler() {},
  async enable() {},
  async replaceChat() {
    if (rejectReplacement) throw new Error('index unavailable');
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
  listChatIds: () => ['chat-1'],
  ledger: {
    currentView: () => ({ viewId: 'view-1', contentStartOrdinal: 1 }),
    currentRows: () => [],
    subscribe: () => () => {},
  },
  service,
});

await controller.initialize(true);
rejectReplacement = true;
controller.sourceMayHaveChanged('chat-1');
await Bun.sleep(25);
await controller.close();
