import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, copyFile, rm, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatRegistry } from '../../../server/controller/chats/store.js';
import { runProjectPathUpdateTransaction } from '../../../server/controller/agents/project-path-update-transaction.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.js';
import { TranscriptAdoptionService } from '../../../server/controller/ledger/adoption.js';
import { transcriptViewId } from '../../../server/controller/ledger/contracts.js';
import { rejectionOf, throwingRejectionOf } from '../../support/promise-assertions.js';

test.each(['success', 'before-commit', 'after-commit'] as const)(
  'relocation preserves authoritative native history across %s publication', async (failure) => {
    const root = await mkdtemp(join(homedir(), 'relocation-publication-'));
    const source = join(root, 'source.jsonl');
    const destination = join(root, 'destination.jsonl');
    const chatId = '1783725900000201';
    const native = (path: string) => ({ ownerId: 'test', schemaVersion: 1, value: { path } });
    const session = (path: string) => ({ agentSessionId: 'synthetic-session', nativeSession: native(path), nativeSeedReceipt: null });
    const registry = new ChatRegistry(root);
    const store = new TranscriptLedgerStore(join(root, 'transcript-ledgers'));
    const ledger = new TranscriptLedgerService(store);
    try {
      await registry.init();
      registry.addChat({ id: chatId, agentId: 'test', projectPath: '/source', model: 'synthetic-model',
        preambleSelection: { revision: 0, orderedPreambleIds: [] },
        agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } }, parentChat: null });
      registry.updateChat(chatId, session(source));
      await registry.flush();
      await writeFile(source, 'Synthetic native history');
      store.initializeCurrentView(chatId, { viewId: transcriptViewId('synthetic-view'), contentStartOrdinal: 1,
        rows: [{ kind: 'session', at: '2026-10-02T00:00:00.000Z', detail: session(source) }] });

      const operation = runProjectPathUpdateTransaction({
        chatId, agentId: 'test', fallbackNativeSession: undefined,
        prepare: async () => {
          await copyFile(source, destination);
          return { nativeSession: native(destination), commit: async () => {
            expect(ledger.currentSession(chatId)?.detail.nativeSession).toEqual(native(destination));
            await rm(source);
          }, rollback: () => rm(destination) };
        },
        persist: (nativeSession) => registry.updateProjectPath(chatId, {
          chatId, projectPath: '/destination', previousProjectPath: '/source', effectiveProjectKey: '/destination', nativeSession,
        }, { flush: true }),
        publish: () => {
          if (failure === 'before-commit') throw new Error('Synthetic publication failure');
          ledger.openProducer(chatId, 'test').sink.publish({ type: 'session', session: session(destination) });
          if (failure === 'after-commit') throw new Error('Synthetic publication failure');
        },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
      if (failure === 'success') await operation;
      else expect(await throwingRejectionOf(operation)).toThrow('Synthetic publication failure');
      const reopened = new ChatRegistry(root);
      await reopened.init();
      await new TranscriptAdoptionService({ registry: reopened, ledger,
        integrations: { require() { throw new Error('Native import must not run'); } },
        getCarryOverRevision: () => 'none', loadFrozenPrefix: async () => [],
      }).ensure(chatId);
      await reopened.flush();
      const authoritative = failure === 'before-commit' ? source : destination;
      expect(reopened.getChat(chatId)?.nativeSession).toEqual(native(authoritative));
      await access(authoritative);
      await access(destination);
      if (failure !== 'success') await access(source);
      else expect(await rejectionOf(access(source))).toMatchObject({ code: 'ENOENT' });
    } finally {
      await registry.flush();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
