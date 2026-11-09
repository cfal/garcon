import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AssistantMessage, BashToolUseMessage, ErrorMessage, UserMessage } from '../../../../common/chat-types.ts';
import { parseTranscriptAnchorResponse } from '../../../../common/transcript-anchor-page.ts';
import { readAnchorPage, TRANSCRIPT_ANCHOR_BYTE_TARGET } from '../anchor-page.ts';
import { encodeLedgerDraft } from '../codec.ts';
import { createSchema } from '../connection-setup.ts';
import { transcriptViewId } from '../contracts.ts';
import { ledgerRowsToTranscriptMessages } from '../presentation.ts';
import { encodeDrafts, insertEncodedRows } from '../staging-views.ts';

const TS = '2026-01-01T00:00:00.000Z';
const VIEW = transcriptViewId('synthetic-view');
const provider = message => ({ kind: 'provider-row', at: TS, message });
const user = () => provider(new UserMessage(TS, 'Synthetic input'));
const assistant = () => provider(new AssistantMessage(TS, 'Synthetic response'));
const tool = () => provider(new BashToolUseMessage(TS, 'synthetic-tool', 'true'));
const hidden = () => ({ kind: 'run-ended', at: TS, origin: 'core', outcome: 'finished' });
const notice = message => ({ kind: 'notice', at: TS, message, detail: {} });
const size = draft => Buffer.byteLength(encodeLedgerDraft(draft).payloadJson, 'utf8');
let db;
let head;

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
  db.query('INSERT INTO transcript_views VALUES (?, ?, ?, ?)').run(VIEW, 'current', TS, 1);
  head = 0;
});
afterEach(() => db.close());

function append(drafts) {
  insertEncodedRows(db, VIEW, encodeDrafts(drafts), head + 1);
  head += drafts.length;
}

function scan(direction, anchorsRemaining, options = {}) {
  const watermarkOrdinal = options.watermarkOrdinal ?? head;
  const cursorOrdinal = options.cursorOrdinal ?? (direction === 'backward' ? watermarkOrdinal + 1 : 0);
  const result = readAnchorPage(db, VIEW, { direction, anchorsRemaining, watermarkOrdinal, cursorOrdinal });
  const response = { ...result, historyState: { kind: 'complete' }, chatId: 'synthetic-chat',
    transcriptViewId: VIEW, direction, watermarkOrdinal, lastOrdinal: head,
    messages: ledgerRowsToTranscriptMessages(result.rows), resendCandidates: [] };
  parseTranscriptAnchorResponse({ chatId: 'synthetic-chat', transcriptViewId: VIEW,
    direction, anchorsRemaining, watermarkOrdinal, cursorOrdinal }, response);
  return result;
}

describe('bounded conversational anchor scan', () => {
  it('keeps adjoining tools with a response backward and a prompt forward', () => {
    append([user(), tool(), notice('Synthetic result'), assistant()]);
    expect(scan('backward', 1)).toMatchObject({ startOrdinal: 2, endOrdinal: 5, anchorsRemaining: 0, pageStatus: 'complete' });
    expect(scan('backward', 1).rows.map(row => row.ordinal)).toEqual([2, 3, 4]);
    expect(scan('forward', 1)).toMatchObject({ startOrdinal: 1, endOrdinal: 4, anchorsRemaining: 0, pageStatus: 'complete' });
    expect(scan('forward', 1).rows.map(row => row.ordinal)).toEqual([1, 2, 3]);
    expect(scan('backward', 1, { cursorOrdinal: 2 })).toMatchObject({ startOrdinal: 1, endOrdinal: 2, pageStatus: 'exhausted' });
    expect(scan('forward', 1, { cursorOrdinal: 3 })).toMatchObject({ startOrdinal: 4, endOrdinal: 5, pageStatus: 'exhausted' });
  });

  it.each(['backward', 'forward'])('exhausts empty history and exactly K anchors with hidden edges (%s)', direction => {
    expect(scan(direction, 2)).toMatchObject({ rows: [], startOrdinal: 1, endOrdinal: 1, anchorsRemaining: 2, pageStatus: 'exhausted' });
    append([hidden(), user(), tool(), assistant(), hidden()]);
    expect(scan(direction, 2)).toMatchObject({ startOrdinal: 1, endOrdinal: 6, anchorsRemaining: 0, pageStatus: 'exhausted' });
    const cursorOrdinal = direction === 'backward' ? 1 : head;
    expect(scan(direction, 2, { cursorOrdinal })).toMatchObject({ rows: [], anchorsRemaining: 2, pageStatus: 'exhausted' });
  });

  it('counts core and imported users, but not visible errors or private metadata', () => {
    append([
      { kind: 'user-input', at: TS, detail: { clientMessageId: null, message: new UserMessage(TS, 'Synthetic core input'), attachments: [], steer: false } },
      { ...user(), providerMeta: { syntheticPrivate: 'not-public' } },
      provider(new ErrorMessage(TS, 'Synthetic visible error')),
      assistant(),
    ]);
    const result = scan('forward', 2);
    expect(result).toMatchObject({ startOrdinal: 1, endOrdinal: 4, pageStatus: 'complete' });
    expect(ledgerRowsToTranscriptMessages(result.rows).map(entry => entry.message.type)).toEqual(['user-message', 'user-message', 'error']);
    expect(JSON.stringify(ledgerRowsToTranscriptMessages(result.rows))).not.toContain('not-public');
  });

  it.each(['backward', 'forward'])('advances all-hidden and zero-anchor intervals by raw coverage (%s)', direction => {
    append(Array.from({ length: 405 }, hidden));
    let cursorOrdinal = direction === 'backward' ? 406 : 0;
    const consumed = [];
    for (let chunk = 0; chunk < 3; chunk++) {
      const result = scan(direction, 3, { cursorOrdinal });
      expect(result.anchorsRemaining).toBe(3);
      expect(ledgerRowsToTranscriptMessages(result.rows)).toEqual([]);
      expect(result.endOrdinal - result.startOrdinal).toBe(chunk < 2 ? 200 : 5);
      expect(result.pageStatus).toBe(chunk < 2 ? 'partial' : 'exhausted');
      consumed.push(...result.rows.map(row => row.ordinal));
      cursorOrdinal = direction === 'backward' ? result.startOrdinal : result.endOrdinal - 1;
    }
    expect(new Set(consumed).size).toBe(405);
  });

  it.each(['backward', 'forward'])('checks a 201st boundary anchor before the raw cap (%s)', direction => {
    const run = [assistant(), ...Array.from({ length: 199 }, tool), user()];
    append(direction === 'forward' ? run : run.reverse());
    const result = scan(direction, 1);
    expect(result.rows).toHaveLength(200);
    expect(result.anchorsRemaining).toBe(0);
    expect(result.pageStatus).toBe('complete');
  });

  it.each(['backward', 'forward'])('continues with zero budget when a 201st zero-weight row remains (%s)', direction => {
    const run = [assistant(), ...Array.from({ length: 201 }, tool), user()];
    append(direction === 'forward' ? run : run.reverse());
    const first = scan(direction, 1);
    expect(first).toMatchObject({ anchorsRemaining: 0, pageStatus: 'partial' });
    const cursorOrdinal = direction === 'backward' ? first.startOrdinal : first.endOrdinal - 1;
    const second = scan(direction, 0, { cursorOrdinal });
    expect(second.rows).toHaveLength(2);
    expect(second).toMatchObject({ anchorsRemaining: 0, pageStatus: 'complete' });
  });

  it.each(['backward', 'forward'])('returns an empty completion at an excluded adjoining anchor (%s)', direction => {
    append([user(), assistant()]);
    const result = scan(direction, 0);
    expect(result.rows).toEqual([]);
    expect(result.pageStatus).toBe('complete');
    expect(result.startOrdinal).toBe(direction === 'backward' ? 3 : 1);
    expect(result.endOrdinal).toBe(result.startOrdinal);
  });

  it.each([0, 1])('honors exact UTF-8 payload target with %s excess bytes', excess => {
    const small = notice('\u00e9'.repeat(32));
    const empty = notice('');
    const large = notice('x'.repeat(TRANSCRIPT_ANCHOR_BYTE_TARGET - size(small) - size(empty) + excess));
    append([small, large, user()]);
    const result = scan('forward', 1);
    expect(result.rows).toHaveLength(excess === 0 ? 2 : 1);
    expect(result.pageStatus).toBe('partial');
  });

  it('allows an oversized first row but leaves an oversized lookahead unconsumed', () => {
    const large = notice('x'.repeat(TRANSCRIPT_ANCHOR_BYTE_TARGET + 1));
    append([notice('small prefix'), large, user()]);
    expect(scan('forward', 1)).toMatchObject({ startOrdinal: 1, endOrdinal: 2, pageStatus: 'partial' });
    expect(scan('forward', 1, { cursorOrdinal: 1 })).toMatchObject({ startOrdinal: 2, endOrdinal: 3, pageStatus: 'partial' });
    expect(scan('forward', 0, { cursorOrdinal: 1 })).toMatchObject({ startOrdinal: 2, endOrdinal: 3, pageStatus: 'complete' });
  });

  it('excludes a boundary anchor even when consuming it would exceed the byte budget', () => {
    append([assistant(), provider(new UserMessage(TS, 'x'.repeat(TRANSCRIPT_ANCHOR_BYTE_TARGET + 1)))]);
    expect(scan('forward', 1)).toMatchObject({ startOrdinal: 1, endOrdinal: 2, pageStatus: 'complete' });
  });

  it('holds the captured watermark under appends and lets a fresh demand see the new head', () => {
    append(Array.from({ length: 201 }, tool));
    const first = scan('forward', 1);
    append([assistant()]);
    expect(scan('forward', 1, { cursorOrdinal: first.endOrdinal - 1, watermarkOrdinal: 201 }))
      .toMatchObject({ startOrdinal: 201, endOrdinal: 202, pageStatus: 'exhausted', anchorsRemaining: 1 });
    expect(scan('forward', 1, { cursorOrdinal: 201 }))
      .toMatchObject({ startOrdinal: 202, endOrdinal: 203, pageStatus: 'exhausted', anchorsRemaining: 0 });
  });

  it('partitions synthetic mixed history without skipped or duplicated raw ordinals', () => {
    append(Array.from({ length: 1207 }, (_, index) => {
      if (index % 113 === 0) return user();
      if (index % 79 === 0) return assistant();
      if (index % 3 === 0) return hidden();
      return tool();
    }));
    for (const direction of ['backward', 'forward']) {
      let cursorOrdinal = direction === 'backward' ? head + 1 : 0;
      let remaining = 3;
      const ordinals = [];
      for (let count = 0; count < 30; count++) {
        const result = scan(direction, remaining, { cursorOrdinal });
        ordinals.push(...result.rows.map(row => row.ordinal));
        if (result.pageStatus === 'exhausted') break;
        cursorOrdinal = direction === 'backward' ? result.startOrdinal : result.endOrdinal - 1;
        remaining = result.pageStatus === 'partial' ? result.anchorsRemaining : 3;
      }
      expect(ordinals.toSorted((a, b) => a - b)).toEqual(Array.from({ length: head }, (_, index) => index + 1));
    }
  });

  it('uses the existing primary key and never changes the schema', () => {
    append([user(), tool(), assistant()]);
    const schema = db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    const plan = db.query('EXPLAIN QUERY PLAN SELECT * FROM transcript_rows WHERE view_id = ? AND ordinal < ? AND ordinal <= ? ORDER BY ordinal DESC LIMIT ?').all(VIEW, 4, 3, 201);
    expect(plan.some(row => row.detail.includes('PRIMARY KEY'))).toBe(true);
    scan('backward', 1);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  });
});
