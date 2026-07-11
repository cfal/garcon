import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { CommandLedger } from '../../commands/command-ledger.js';
import { ChatCommandService } from '../../commands/chat-command-service.js';
import { forkChatFileCopy } from '../../chats/fork-chat.js';
import { ChatIdAllocator } from '../../chats/chat-id-allocator.js';

export function createRouteCommandLedger(label = 'chat-routes') {
  return new CommandLedger(path.join(os.tmpdir(), `garcon-${label}-ledger-${randomUUID()}`));
}

export function createRoutePendingInputs() {
  return {
    register: () => Promise.resolve(undefined),
    reconcile: () => Promise.resolve(undefined),
    listForChat: () => [],
    clearChat: () => undefined,
    discardChat: () => 0,
    discard: () => false,
  };
}

export function createRouteChatViews() {
  return {
    getOrCreatePage: () => Promise.resolve({
      messages: [],
      generationId: 'generation-1',
      lastSeq: 0,
      pageOldestSeq: 0,
      hasMore: false,
    }),
  };
}

export function createRouteCommandService({
  registry,
  queue,
  settings,
  metadata,
  agents,
  commandLedger,
  pendingInputs,
  forkChatFileCopy: forkChatFileCopyOverride,
}) {
  return new ChatCommandService({
    chats: registry,
    queue,
    settings,
    metadata,
    agents,
    ledger: commandLedger,
    pendingInputs,
    chatIds: new ChatIdAllocator(registry),
    forkChatFileCopy: forkChatFileCopyOverride ?? forkChatFileCopy,
  });
}
