import { BashToolUseMessage, UserMessage } from '../../../common/chat-types.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [operation, root] = Bun.argv.slice(2);
const chatId = 'synthetic-chat';
const at = '2026-11-28T09:00:00.000Z';
const store = new TranscriptLedgerStore(root!, {
  createViewId: () => transcriptViewId('synthetic-view'),
  now: () => at,
});

try {
  if (operation === 'write') {
    const view = store.initializeCurrentView(chatId, { contentStartOrdinal: 1 });
    const drafts: LedgerRowDraft[] = [
      {
        kind: 'permission-requested',
        at,
        providerMeta: { a: 1.0, exp: 1e21, big: Number('9007199254740993'), fraction: 1e-7 },
        lifecycle: {
          kind: 'requested',
          permissionOccurrenceId: '11111111-1111-4111-8111-111111111111',
          requestedTool: new BashToolUseMessage(at, 'synthetic-tool', 'pwd'),
          options: [{ id: 'allow', label: 'Allow' }],
          reason: 'Synthetic approval reason',
        },
      },
      {
        kind: 'user-input',
        at,
        detail: {
          clientMessageId: 'synthetic-submission',
          message: new UserMessage(at, 'Synthetic user input'),
          attachments: [],
          steer: false,
          preambleBoundary: null,
          preamblePrefixReceipt: null,
        },
      },
      {
        kind: 'notice',
        at,
        detail: {
          type: 'cli-row',
          clientMessageId: 'synthetic-notice',
          presentation: {
            style: 'custom',
            customStyle: { lightAccent: '#000000', darkAccent: '#ffffff' },
          },
          format: 'markdown',
          disclosure: 'collapsed',
          title: 'Synthetic title',
        },
        message: '**Synthetic note**',
      },
    ];
    store.append(chatId, view.viewId, drafts);
  } else if (operation !== 'read') {
    throw new Error('Expected write or read');
  }
  console.log(JSON.stringify(store.currentRows(chatId)));
} finally {
  store.close();
}
