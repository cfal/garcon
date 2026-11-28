import type { AgentHistoryImport, AgentIntegration } from '@garcon/server-agent-interface';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { createPreamblePrefix } from '../../../common/preamble-prefix.ts';
import { createNativeSeedReceipt } from '../../../common/transcript-seed.ts';
import { KeyedPromiseLock } from '../../../server/common/keyed-lock.ts';
import { emptyStoredChatExecutionControl } from '../../../server/controller/chat-execution/control-state.ts';
import { ChatRegistry } from '../../../server/controller/chats/store.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptReloadService } from '../../../server/controller/ledger/reload.ts';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';
import type { ChatReloadProgress } from '../../../common/ws-events.ts';

if (Bun.version !== '1.4.3') throw new Error('Expected Bun 1.4.3, received ' + Bun.version);
const [mode, root] = Bun.argv.slice(2) as [string, string];
const chatId = '1795856400000000';
const at = '2026-11-28T09:00:00.000Z';
const source = transcriptViewId('11111111-1111-4111-8111-111111111111');
const carried = '<carried-context>Synthetic earlier context</carried-context>\n';
const prefix = createPreamblePrefix({ contents: ['Synthetic private preamble \u{1f680}'] })!;
const session = {
  agentSessionId: 'synthetic-session',
  nativeSession: { ownerId: 'shell', schemaVersion: 1, value: { nativeId: 'synthetic' } },
  nativeSeedReceipt: createNativeSeedReceipt({ agentSessionId: 'synthetic-session', placement: 'user-prefix', prefix: carried }),
};
const boundary = { kind: 'new-chat', ownershipEpoch: 'owner-1' } as const;
const preambles = [{ id: '3502b645-222b-49d2-ac39-1c91f9fb1174', title: 'Synthetic rules' }];
const store = new TranscriptLedgerStore(root, { now: () => at });
const ledger = new TranscriptLedgerService(store);
const progress: ChatReloadProgress[] = [];
let replacement;
try {
  if (mode === 'write') {
    const rows: LedgerRowDraft[] = [
      { kind: 'provider-row', at, message: new AssistantMessage(at, 'Frozen answer') },
      { kind: 'notice', at, message: 'Synthetic quarantine', detail: {
        type: 'carryover-migration-quarantine', artifactId: 'artifact-1', errorCode: 'CARRYOVER_PARSE_FAILED',
      } },
      { kind: 'session', at, detail: session },
      { kind: 'notice', at, message: 'Preambles applied', detail: { type: 'preamble-application', preambles } },
      { kind: 'user-input', at, detail: { message: new UserMessage(at, 'Old input'), clientMessageId: 'input-1',
        attachments: [], steer: false, preambleBoundary: boundary, preamblePrefixReceipt: prefix.receipt } },
      { kind: 'run-ended', at, outcome: 'finished', origin: 'provider' },
    ];
    const original = store.initializeCurrentView(chatId, { viewId: source, rows, contentStartOrdinal: 3 });
    const registry = new ChatRegistry(root);
    await registry.init();
    registry.addChat({
      id: chatId, agentId: 'shell', model: 'synthetic', projectPath: root, agentOwnershipEpoch: 'owner-1',
      agentSessionId: 'stale-registry-cache', pendingPreambleBoundary: boundary,
      preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId: null, lineage: null,
    });
    const native = {
      async *load({ chat }) {
        if (chat.agentSessionId !== session.agentSessionId || chat.nativeSession?.value.nativeId !== 'synthetic') {
          throw new Error('Did not select the durable session');
        }
        yield [{ message: new UserMessage(at, carried + prefix.prefix + 'Visible question'), providerMeta: { event: 1 } }];
        yield [{ message: new AssistantMessage(at, 'Visible answer'), providerMeta: { event: 2 } }];
      },
    } satisfies AgentHistoryImport;
    const integration = {
      descriptor: { id: 'shell' },
      settings: { defaults: () => ({ ownerId: 'shell', schemaVersion: 1, values: {} }), parse: value => value },
      nativeHistoryImport: native,
    } satisfies {
      descriptor: Pick<AgentIntegration['descriptor'], 'id'>;
      settings: Pick<AgentIntegration['settings'], 'defaults' | 'parse'>;
      nativeHistoryImport: AgentHistoryImport;
    };
    const reload = new TranscriptReloadService({
      ledger, registry, chatMutationLock: new KeyedPromiseLock(), adoption: { ensure: async () => original },
      integrations: { require: () => integration as AgentIntegration },
      getCarryOverRevision: () => 'synthetic-revision',
      execution: {
        reserveTranscriptSnapshot: () => ({ chatId, reservationId: 'synthetic-reservation' }),
        releaseTranscriptSnapshot: async () => {},
        readChatExecutionControl: async () => emptyStoredChatExecutionControl('synthetic-server'),
      },
      reopenProducer: id => { ledger.openProducer(id, 'shell'); },
      now: () => at,
    });
    replacement = await reload.reload(chatId, { onProgress: update => progress.push(update) });
    if (registry.getChat(chatId)?.pendingPreambleBoundary !== null) throw new Error('Boundary was not cleared');
    await registry.flush();
  } else if (mode !== 'read') {
    throw new Error('Unexpected mode: ' + mode);
  }
  const view = store.currentView(chatId);
  const rows = await store.withStoredRowsThrough(chatId, store.highWatermark(chatId), async rows => rows);
  console.log(JSON.stringify({ snapshot: { view, rows }, ...(replacement ? { replacement, progress } : {}) }));
} finally {
  ledger.close();
}
