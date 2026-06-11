import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { CommandLedger } from '../../commands/command-ledger.js';

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
