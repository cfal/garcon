import { afterEach, expect, test } from 'bun:test';
import { AssistantMessage, UserMessage } from '../../../../common/chat-types.js';
import type { DisplayAuxiliaryRequest } from '../../../../common/transcript-display-auxiliary.js';
import { parseUserRowPage } from '../../../../common/transcript-display-auxiliary.js';
import { encodeLedgerDraft } from '../../ledger/codec.js';
import type { LedgerRowDraft } from '../../ledger/contracts.js';
import { queryUserRows } from '../auxiliary-query.js';
import { appendDisplayFrame } from '../extractor.js';
import { DisplayStore } from '../store.js';

const at = '2026-01-01T00:00:00.000Z';
const stores: DisplayStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new DisplayStore(':memory:');
  store.initialize('chat', 'view', 'server');
  stores.push(store);
  const drafts: LedgerRowDraft[] = [];
  const users: { ordinal: number; nonblank: boolean }[] = [];
  for (let index = 0; index < 137; index++) {
    if (index === 60) drafts.push({ kind: 'provider-row', at, message: new AssistantMessage(at, 'Generic response') });
    const nonblank = index % 10 !== 0, literal = index === 85;
    users.push({ ordinal: drafts.length + 1, nonblank });
    drafts.push({ kind: 'user-input', at, detail: { clientMessageId: `input-${index}`,
      message: new UserMessage(at, nonblank ? `Generic prompt ${index}` : ' ', undefined, literal ? { contentMode: 'literal' } : undefined),
      attachments: [], steer: false, preambleBoundary: null, preamblePrefixReceipt: null } });
  }
  drafts.push({ kind: 'provider-row', at, message: new AssistantMessage(at, 'Generic final response') });
  const rows = drafts.map((draft, index) => ({ view_id: 'view', ordinal: index + 1, kind: draft.kind, at,
    client_message_id: draft.kind === 'user-input' ? draft.detail.clientMessageId : null, payload_json: encodeLedgerDraft(draft).payloadJson }));
  for (let offset = 0; offset < rows.length; offset += 17) appendDisplayFrame(store, rows.slice(offset, offset + 17), rows.length, 'server');
  const identity = (watermark: number) => ({ serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view', watermark, sourceHead: rows.length });
  return { store, users, identity };
}

test.each(['navigation', 'recall'] as const)('pages every %s user row at a captured watermark without duplicates or future rows', mode => {
  const { store, users, identity } = fixture();
  const expected = users.filter(user => user.ordinal <= 100 && (mode === 'navigation' || user.nonblank)).map(user => user.ordinal).reverse();
  let input: DisplayAuxiliaryRequest = { chatId: 'chat', transcriptViewId: 'view', mode, limit: 17 };
  const collected: number[] = [];
  for (let offset = 0; offset < expected.length; offset += input.limit) {
    const page = queryUserRows(store, input, identity(100));
    expect(parseUserRowPage(page)).toEqual(page);
    expect(page.rows.map(row => row.ordinal)).toEqual(expected.slice(offset, offset + input.limit));
    expect(page.nextBeforeOrdinal).toBe(offset + input.limit < expected.length ? expected[offset + input.limit - 1] : null);
    collected.push(...page.rows.map(row => row.ordinal));
    if (page.nextBeforeOrdinal === null) break;
    input = { ...input, beforeOrdinal: page.nextBeforeOrdinal };
  }
  expect(collected).toEqual(expected);
  expect(queryUserRows(store, { ...input, beforeOrdinal: 1 }, identity(100)).rows).toEqual([]);
});
