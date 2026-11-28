import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { safeFenceDiagnostic } from '../../../server/controller/ledger/errors.ts';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error('Expected Bun 1.4.3, received ' + Bun.version);
const [mode, root] = Bun.argv.slice(2) as [string, string];
const at = '2026-11-28T09:00:00.000Z';
const viewId = transcriptViewId('activity-view');
const chats = ['finished', 'failed', 'interrupted', 'input', 'provider-input', 'empty'] as const;
const registered = new Set<string>([...chats, 'broken']);
const store = new TranscriptLedgerStore(root, { now: () => at, createViewId: () => viewId });
const ledger = new TranscriptLedgerService(store);
const provider = (message: AssistantMessage | UserMessage): LedgerRowDraft => ({ kind: 'provider-row', at, message });
const terminal = (outcome: 'finished' | 'failed' | 'interrupted'): LedgerRowDraft =>
  ({ kind: 'run-ended', at, outcome, origin: 'provider' });
const input = new UserMessage(at, 'Synthetic input');

try {
  if (mode === 'write') {
    for (const chatId of chats) {
      const rows: LedgerRowDraft[] = chatId === 'empty' ? []
        : chatId === 'provider-input' ? [terminal('failed'), provider(input)]
        : chatId === 'input' ? [terminal('failed'), { kind: 'user-input', at,
          detail: { clientMessageId: null, message: input, attachments: [], steer: false,
            preambleBoundary: null, preamblePrefixReceipt: null }, providerMeta: null }]
        : [terminal(chatId)];
      if (chatId !== 'empty') rows.push(provider(new AssistantMessage(at, 'Synthetic suffix')));
      store.initializeCurrentView(chatId, { contentStartOrdinal: 1, rows });
    }
    store.initializeCurrentView('broken', { contentStartOrdinal: 1, rows: [terminal('failed')] });
    const db = new Database(join(root, 'broken', 'ledger.sqlite'));
    try {
      db.query('UPDATE transcript_rows SET payload_json = ?').run('{"value":?}');
    } finally {
      db.close();
    }
  } else if (mode !== 'read') throw new Error('Unknown oracle mode: ' + mode);
  store.initializeCurrentView('orphan', { contentStartOrdinal: 1 });
  writeFileSync(join(root, 'orphan-file'), 'unrelated');
  mkdirSync(join(root, '.trash', 'interrupted-delete'), { recursive: true });
  const removed = store.removeUnregisteredChatDirectories(registered);
  const remaining = existsSync(join(root, 'orphan-file'));
  const outcomes = [];
  for (const id of chats) outcomes.push(await ledger.lastRunOutcome(id, viewId));
  let fence;
  try {
    await ledger.lastRunOutcome('broken', viewId);
  } catch (error) {
    fence = safeFenceDiagnostic(error);
  }
  console.log(JSON.stringify({ removed, remaining, outcomes, fence }));
} finally {
  ledger.close();
}
