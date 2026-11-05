import { join } from 'node:path';
import { AssistantMessage, BashToolUseMessage, ToolResultMessage, UserMessage } from '../../common/chat-types.js';
import type { LedgerRowDraft } from '../../server/controller/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../server/controller/ledger/store.js';
import type { IntegrationFixture } from './integration-fixture.js';

export const DISPLAY_TIMESTAMP = '2026-01-01T00:00:00.000Z';
export const DISPLAY_PROMPT = 'Synthetic prompt before the collapsed run';
export const DISPLAY_TARGET = 'syntheticdeepmember';

export async function createDisplayChat(fixture: IntegrationFixture, content = 'Synthetic display fixture'): Promise<string> {
  const chatId = fixture.newChatId();
  const turn = await fixture.client.startDirectChat({ chatId, content,
    projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi });
  await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
  return chatId;
}

// The owning fixture stops the controller before changing its synthetic source.
export async function appendDisplayRun(workspace: string, chatId: string, pairs: number, command?: string) {
  const store = new TranscriptLedgerStore(join(workspace, 'transcript-ledgers'));
  try {
    const view = store.currentView(chatId);
    if (!view) throw new Error('Synthetic display fixture has no current view.');
    const start = store.highWatermark(chatId).ordinal + 1;
    store.append(chatId, view.viewId, [{ kind: 'user-input', at: DISPLAY_TIMESTAMP, providerMeta: null,
      detail: { clientMessageId: `display-input-${start}`, message: new UserMessage(DISPLAY_TIMESTAMP, DISPLAY_PROMPT),
        attachments: [], steer: false, preambleBoundary: null, preamblePrefixReceipt: null } }]);
    const middle = Math.floor(pairs / 2);
    for (let offset = 0; offset < pairs; offset += 128) {
      const rows: LedgerRowDraft[] = [];
      for (let index = offset; index < Math.min(offset + 128, pairs); index++) {
        const id = `synthetic-display-${start}-${index}`;
        const input = new BashToolUseMessage(DISPLAY_TIMESTAMP, id,
          command ?? (index === middle ? `printf ${DISPLAY_TARGET}${pairs}` : 'printf synthetic'));
        rows.push({ kind: 'provider-row', at: DISPLAY_TIMESTAMP, message: input, providerMeta: null },
          { kind: 'provider-row', at: DISPLAY_TIMESTAMP, providerMeta: null,
            message: new ToolResultMessage(DISPLAY_TIMESTAMP, id, { raw: `Synthetic result ${index} ${'x'.repeat(512)}` }, false) });
      }
      store.append(chatId, view.viewId, rows);
      await Bun.sleep(0);
    }
    return { chatId, transcriptViewId: view.viewId, promptOrdinal: start,
      targetOrdinal: start + 1 + middle * 2, sourceHead: start + pairs * 2, pairs };
  } finally { store.close(); }
}

export async function appendDisplayHistory(workspace: string, chatId: string, count: number) {
  const store = new TranscriptLedgerStore(join(workspace, 'transcript-ledgers'));
  try {
    const view = store.currentView(chatId);
    if (!view) throw new Error('Synthetic display fixture has no current view.');
    for (let offset = 0; offset < count; offset += 128) {
      store.append(chatId, view.viewId, Array.from({ length: Math.min(128, count - offset) }, (_, index) => ({
        kind: 'provider-row' as const, at: DISPLAY_TIMESTAMP, providerMeta: null,
        message: new AssistantMessage(DISPLAY_TIMESTAMP, `Synthetic history row ${offset + index}`),
      })));
      await Bun.sleep(0);
    }
  } finally { store.close(); }
}
