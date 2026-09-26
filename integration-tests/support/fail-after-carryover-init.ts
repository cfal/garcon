import { CarryOverTranscriptStore } from '../../server/controller/chats/carryover-transcript-store.js';

const initialize = CarryOverTranscriptStore.prototype.initialize;
CarryOverTranscriptStore.prototype.initialize = async function () {
  await initialize.call(this);
  throw new Error('Synthetic startup failure after workspace initialization');
};
