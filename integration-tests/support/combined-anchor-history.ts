import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { AssistantMessage, BashToolUseMessage, ThinkingMessage, UserMessage } from '../../common/chat-types.js';
import type { LedgerRowDraft } from '../../server/controller/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../server/controller/ledger/store.js';
import type { IntegrationFixture } from './integration-fixture.js';

export const COMBINED_PROMPT = 'Synthetic combined history prompt';
export const COMBINED_RESPONSE = 'Synthetic combined history response';

export async function seedCombinedAnchorHistory(
  fixture: IntegrationFixture,
  options: { tallResponse?: boolean; thinking?: boolean; toolPayloadSize?: number; trailingAnchors?: number } = {},
) {
  const chatId = fixture.newChatId();
  const started = await fixture.client.startDirectChat({
    chatId, content: 'Synthetic combined history seed', projectPath: fixture.dirs.project,
    agent: fixture.directAgents.openAi,
  });
  await fixture.client.waitForTurnTerminal(chatId, started.turnId);
  const initial = await fixture.client.getMessages(chatId);
  const at = '2026-01-01T00:00:00.000Z';
  const rows: LedgerRowDraft[] = [
    { kind: 'provider-row', at, message: new UserMessage(at, COMBINED_PROMPT) },
    ...Array.from({ length: 650 }, (_, index): LedgerRowDraft => index % 10 === 0
      ? { kind: 'run-ended', at, outcome: 'finished', origin: 'core' }
      : { kind: 'provider-row', at, message: new BashToolUseMessage(at, `synthetic-tool-${index}`,
        `printf synthetic-${index}${'x'.repeat(options.toolPayloadSize ?? 0)}`),
        providerMeta: { syntheticPrivateValue: 'not-public' } }),
    ...(options.thinking ? [{ kind: 'provider-row', at, message: new ThinkingMessage(at,
      Array.from({ length: 60 }, (_, index) => `Synthetic reasoning paragraph ${index}.`).join('\n\n')) } satisfies LedgerRowDraft] : []),
    { kind: 'provider-row', at, message: new AssistantMessage(at, options.tallResponse
      ? Array.from({ length: 60 }, (_, index) => `${COMBINED_RESPONSE} ${index}.`).join('\n\n')
      : COMBINED_RESPONSE) },
    ...Array.from({ length: options.trailingAnchors ?? 0 }, (_, index): LedgerRowDraft => ({
      kind: 'provider-row', at, message: new AssistantMessage(at, `Synthetic later anchor ${index}`),
    })),
  ];
  let schemaVersion = 0;
  await fixture.restartGarcon({ beforeStart: async () => {
    const root = join(fixture.dirs.workspace, 'transcript-ledgers');
    const store = new TranscriptLedgerStore(root);
    try {
      const view = store.currentView(chatId);
      if (!view || view.viewId !== initial.transcriptViewId) throw new Error('Synthetic view changed');
      for (let offset = 0; offset < rows.length; offset += 200) {
        store.append(chatId, view.viewId, rows.slice(offset, offset + 200));
      }
    } finally { store.close(); }
    const database = new Database(join(root, chatId, 'ledger.sqlite'), { readonly: true });
    try {
      schemaVersion = database.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
    } finally { database.close(); }
  } });
  return {
    chatId, transcriptViewId: initial.transcriptViewId, schemaVersion,
    promptOrdinal: initial.lastOrdinal + 1, head: initial.lastOrdinal + rows.length,
  };
}
