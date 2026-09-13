import { mock } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from '../../common/json.js';
import * as atomicFiles from '../../server/lib/json-file-store.js';
import { TranscriptLedgerStore } from '../../server/ledger/store.js';

const fixtureRoot = process.env.GARCON_TEST_JOURNAL_FAULT_DIR;
if (!fixtureRoot) throw new Error('Journal fault injection requires an isolated fixture root');
const workspace = join(fixtureRoot, 'workspace');
const journalPath = join(workspace, 'agent-ownership-journal.json');
const modePath = join(fixtureRoot, 'journal-fault-mode');
const attemptsPath = join(fixtureRoot, 'journal-fault-attempts');
const faultChatPath = join(fixtureRoot, 'journal-fault-chat');
const faultNativePath = join(fixtureRoot, 'journal-fault-native-path');
const cleanupFaults = new Set(['native-release-delete', 'delete-completion-before-rename', 'completion']);
const originalOpen = fs.open.bind(fs);
const originalRemove = fs.rm.bind(fs);
const originalWrite = atomicFiles.writeJsonFileAtomic;
const writingFile = new AsyncLocalStorage<string>();
const originalAccess = fs.access.bind(fs);
const relocationGate = process.env.GARCON_TEST_RELOCATION_GATE;
const deleteRetryGate = process.env.GARCON_TEST_DELETE_RETRY_GATE;
const gateToken = process.env.GARCON_TEST_JOURNAL_GATE_TOKEN;
if ((relocationGate || deleteRetryGate) && !gateToken)
  throw new Error('Synthetic journal barriers require a token');

fs.access = async (...args: Parameters<typeof fs.access>) => {
  if (relocationGate && args[0] === join(fixtureRoot, 'project', 'relocation-destination')) {
    const response = await fetch(relocationGate, {
      headers: { authorization: `Bearer ${gateToken}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Synthetic relocation barrier failed');
  }
  return originalAccess(...args);
};

fs.rm = async (...args: Parameters<typeof fs.rm>) => {
  if (faultMode() === 'native-release-delete' && args[0] === readFileSync(faultNativePath, 'utf8')) {
    await fs.appendFile(attemptsPath, 'native-release-delete\n');
    throw Object.assign(new Error('Synthetic native release failure'), { code: 'EIO' });
  }
  return originalRemove(...args);
};

mock.module('../../server/lib/json-file-store.js', () => ({
  ...atomicFiles,
  writeJsonFileAtomic: async (...args: Parameters<typeof originalWrite>) => {
    if (args[0] === journalPath && faultMode() === 'delete-completion-before-rename') {
      const candidate = args[1];
      if (isRecord(candidate) && Array.isArray(candidate.ownershipIntents) && candidate.ownershipIntents.length === 0) {
        await fs.appendFile(attemptsPath, 'delete-completion-before-rename\n');
        throw new Error('Synthetic deletion completion write failure');
      }
    }
    if (args[0] === journalPath && faultMode() === 'delete-retry-race') {
      const candidate = args[1];
      if (isRecord(candidate) && Array.isArray(candidate.ownershipIntents) && candidate.ownershipIntents.length === 0) {
        await reachDeleteRetryGate('completion');
      }
    }
    if (args[0] === join(workspace, 'chats.json') && faultMode() === 'registry-flush-delete') {
      const candidate = args[1];
      if (isRecord(candidate) && isRecord(candidate.sessions) && !Object.hasOwn(candidate.sessions, readFileSync(faultChatPath, 'utf8'))) {
        throw new Error('Synthetic deleted registry flush failure');
      }
    }
    return writingFile.run(args[0], () => originalWrite(...args));
  },
}));

const { AgentOwnershipJournal } = await import('../../server/chats/agent-ownership-journal.js');
const deleteChat = AgentOwnershipJournal.prototype.delete;
AgentOwnershipJournal.prototype.delete = async function (chatId: string) {
  if (faultMode() === 'delete-retry-race' && this.pendingKind(chatId) === 'delete') {
    await reachDeleteRetryGate('retry');
    await this.waitForProviderCleanup();
  }
  const result = await deleteChat.call(this, chatId);
  // Fixture responses may wait for cleanup; production deletion remains detached.
  const mode = faultMode();
  if (cleanupFaults.has(mode) || mode === 'await-cleanup-settlement') await this.waitForProviderCleanup();
  if (mode === 'await-cleanup-settlement' && this.hasPending(chatId)) {
    throw new Error('Synthetic cleanup settlement retained the deleted chat identity');
  }
  return result;
};

async function reachDeleteRetryGate(stage: 'completion' | 'retry'): Promise<void> {
  if (!deleteRetryGate) throw new Error('Synthetic delete race requires its barrier');
  const response = await fetch(new URL(stage, deleteRetryGate), {
    headers: { authorization: `Bearer ${gateToken}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Synthetic delete barrier failed');
}

const deleteLedger = TranscriptLedgerStore.prototype.deleteChat;
TranscriptLedgerStore.prototype.deleteChat = function (chatId: string) {
  if (faultMode() === 'ledger-delete' && chatId === readFileSync(faultChatPath, 'utf8')) {
    throw new Error('Synthetic controller ledger removal failure');
  }
  deleteLedger.call(this, chatId);
};

function faultMode(): string {
  try {
    return readFileSync(modePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return 'none';
  }
}

// Loaded only by the fixture child; the real atomic writer must classify a directory-sync failure after rename.
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const file = await originalOpen(...args);
  if (args[0] !== workspace || args[1] !== 'r' || writingFile.getStore() !== journalPath) return file;
  const sync = file.sync.bind(file);
  file.sync = async () => {
    let mode: string;
    let bytes: string;
    try {
      mode = await fs.readFile(modePath, 'utf8');
      if (mode === 'none') return sync();
      bytes = await fs.readFile(journalPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return sync();
    }
    const journal: unknown = JSON.parse(bytes);
    if (!isRecord(journal) || !Array.isArray(journal.ownershipIntents)) throw new Error('Invalid fault fixture journal');
    const matches = mode === 'decision'
      ? journal.ownershipIntents.some((intent) => isRecord(intent) && intent.kind === 'handoff' && intent.phase === 'commit-decided')
      : mode === 'prepared-delete'
        ? journal.ownershipIntents.some((intent) => isRecord(intent) && intent.kind === 'delete' && intent.phase === 'prepared')
        : mode === 'registry-removed-delete'
          ? journal.ownershipIntents.some((intent) => isRecord(intent) && intent.kind === 'delete' && intent.phase === 'registry-removed')
        : mode === 'completion' && journal.ownershipIntents.length === 0;
    if (!matches) return sync();
    await fs.appendFile(attemptsPath, `${createHash('sha256').update(bytes).digest('hex')}\n`);
    throw Object.assign(new Error('Synthetic ownership directory sync failure'), { code: 'EIO' });
  };
  return file;
};
