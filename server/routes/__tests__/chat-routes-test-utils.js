import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { CommandLedger } from '../../commands/command-ledger.js';
import { ChatCommandService } from '../../commands/chat-command-service.js';

export function createRouteCommandLedger(label = 'chat-routes') {
  return new CommandLedger(path.join(os.tmpdir(), `garcon-${label}-ledger-${randomUUID()}`));
}

export function createRoutePendingInputs() {
  return {
    register: () => Promise.resolve(undefined),
    reconcile: () => Promise.resolve(undefined),
    listForChat: () => [],
    clearChat: () => undefined,
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
}) {
  return new ChatCommandService({
    chats: registry,
    queue,
    settings,
    metadata,
    agents,
    ledger: commandLedger,
    pendingInputs,
  });
}
