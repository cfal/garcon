import { UserMessage } from '../../../common/chat-types.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';
import { inputDetail } from '../../../server/controller/ledger/input-submission.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const at = '2026-11-28T09:00:00.000Z';
const [root, chatId] = Bun.argv.slice(2) as [string, string];
const store = new TranscriptLedgerStore(root);
try {
  const view = store.currentView(chatId);
  if (!view) throw new Error('Expected an initialized view');
  const detail = inputDetail({
    message: new UserMessage(at, 'next input'),
    attachments: [],
    clientMessageId: 'next',
    steer: false,
  });
  const started = performance.now();
  const result = store.appendInputAndCompose(chatId, {
    viewId: view.viewId, at, detail, preambleBoundary: null, preambles: [],
  });
  const elapsed = performance.now() - started;
  console.error(`Bun append-and-compose with 20,000 transparent rows: ${elapsed.toFixed(2)} ms`);
  console.log(JSON.stringify(result));
} finally {
  store.close();
}
