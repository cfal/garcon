import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AssistantMessage, BashToolUseMessage, ErrorMessage, UserMessage } from '../../../../common/chat-types.ts';
import { parseTranscriptAnchorResponse } from '../../../../common/transcript-anchor-page.ts';
import { readAnchorBatch, readAnchorPage } from '../anchor-page.ts';
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
  const input = { direction, anchorsRemaining, watermarkOrdinal, cursorOrdinal };
  let progress = input;
  const rows = [];
  let batch;
  do {
    let admitted = 0;
    batch = readAnchorBatch(db, VIEW, input, progress, () => ++admitted >= (options.pauseAfter ?? 200));
    rows.push(...batch.rows);
    progress = batch.progress;
  } while (batch.stop === 'yield');
  const result = {
    rows: direction === 'backward' ? rows.reverse() : rows,
    startOrdinal: direction === 'backward' ? progress.cursorOrdinal : cursorOrdinal + 1,
    endOrdinal: direction === 'backward' ? cursorOrdinal : progress.cursorOrdinal + 1,
    anchorsRemaining: progress.anchorsRemaining,
    pageStatus: batch.stop,
  };
  const response = { ...result, historyState: { kind: 'complete' }, chatId: 'synthetic-chat',
    transcriptViewId: VIEW, direction, watermarkOrdinal, lastOrdinal: head,
    messages: ledgerRowsToTranscriptMessages(result.rows), resendCandidates: [] };
  parseTranscriptAnchorResponse({ chatId: 'synthetic-chat', transcriptViewId: VIEW,
    direction, anchorsRemaining, watermarkOrdinal, cursorOrdinal }, response);
  return result;
}

describe('cooperative conversational anchor scan', () => {
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
    const result = scan(direction, 3);
    expect(result.anchorsRemaining).toBe(3);
    expect(ledgerRowsToTranscriptMessages(result.rows)).toEqual([]);
    expect(result.endOrdinal - result.startOrdinal).toBe(405);
    expect(result.pageStatus).toBe('exhausted');
    expect(new Set(result.rows.map(row => row.ordinal)).size).toBe(405);
  });

  it.each(['backward', 'forward'])('checks an excluded anchor across an internal batch boundary (%s)', direction => {
    const run = [assistant(), ...Array.from({ length: 199 }, tool), user()];
    append(direction === 'forward' ? run : run.reverse());
    const result = scan(direction, 1);
    expect(result.rows).toHaveLength(200);
    expect(result.anchorsRemaining).toBe(0);
    expect(result.pageStatus).toBe('complete');
  });

  it.each(['backward', 'forward'])('continues with zero budget through several internal batches (%s)', direction => {
    const run = [assistant(), ...Array.from({ length: 601 }, tool), user()];
    append(direction === 'forward' ? run : run.reverse());
    const first = scan(direction, 1);
    expect(first).toMatchObject({ anchorsRemaining: 0, pageStatus: 'complete' });
    expect(first.rows).toHaveLength(602);
  });

  it.each(['backward', 'forward'])('returns an empty completion at an excluded adjoining anchor (%s)', direction => {
    append([user(), assistant()]);
    const result = scan(direction, 0);
    expect(result.rows).toEqual([]);
    expect(result.pageStatus).toBe('complete');
    expect(result.startOrdinal).toBe(direction === 'backward' ? 3 : 1);
    expect(result.endOrdinal).toBe(result.startOrdinal);
  });

  it.each(['backward', 'forward'])('returns oversized rows and subsequent history in one response (%s)', direction => {
    append([notice('x'.repeat(1024 * 1024 + 1)), ...Array.from({ length: 205 }, tool),
      notice('\u00e9'.repeat(600_000)), user()]);
    expect(scan(direction, 1)).toMatchObject({ startOrdinal: 1, endOrdinal: 209, pageStatus: 'exhausted' });
    expect(scan(direction, 1).rows).toHaveLength(208);
  });

  it('excludes a large boundary anchor regardless of its payload size', () => {
    append([assistant(), provider(new UserMessage(TS, 'x'.repeat(1024 * 1024 + 1)))]);
    expect(scan('forward', 1)).toMatchObject({ startOrdinal: 1, endOrdinal: 2, pageStatus: 'complete' });
  });

  it('advances through a hidden tail and an oversized private row before exposing the prompt', () => {
    append([user(), { kind: 'run-ended', at: TS, origin: 'core', outcome: 'failed',
      error: { code: 'SYNTHETIC_FAILURE', message: 'x'.repeat(1024 * 1024 + 1) } }, hidden()]);
    const prompt = scan('backward', 1);
    expect(prompt).toMatchObject({ startOrdinal: 1, endOrdinal: 4, anchorsRemaining: 0, pageStatus: 'exhausted' });
    expect(prompt.rows).toHaveLength(3);
    expect(ledgerRowsToTranscriptMessages(prompt.rows)).toEqual([{ ordinal: 1, message: user().message }]);
  });

  it('holds the captured watermark under appends and lets a fresh demand see the new head', () => {
    append(Array.from({ length: 201 }, tool));
    const first = scan('forward', 1);
    append([assistant()]);
    expect(scan('forward', 1, { cursorOrdinal: first.endOrdinal - 1, watermarkOrdinal: 201 }))
      .toMatchObject({ startOrdinal: 202, endOrdinal: 202, pageStatus: 'exhausted', anchorsRemaining: 1 });
    expect(scan('forward', 1, { cursorOrdinal: 201 }))
      .toMatchObject({ startOrdinal: 202, endOrdinal: 203, pageStatus: 'exhausted', anchorsRemaining: 0 });
  });

  it.each([1, 2, 7, 200])('partitions history independently of pauses after %s rows', async pauseAfter => {
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
        const result = scan(direction, remaining, { cursorOrdinal, pauseAfter });
        expect(await readAnchorPage(VIEW, {
          direction, cursorOrdinal, watermarkOrdinal: head, anchorsRemaining: remaining,
        }, work => work(db))).toEqual(result);
        ordinals.push(...result.rows.map(row => row.ordinal));
        if (result.pageStatus === 'exhausted') break;
        cursorOrdinal = direction === 'backward' ? result.startOrdinal : result.endOrdinal - 1;
        remaining = 3;
      }
      expect(ordinals.toSorted((a, b) => a - b)).toEqual(Array.from({ length: head }, (_, index) => index + 1));
    }
  });

  for (const direction of ['backward', 'forward']) {
    it.each([
      ['boundary', 1, 2, 'complete'],
      ['batch-limit', 200, 200, 'yield'],
      ['oversized-row', 3, 3, 'exhausted'],
      ['decode-error', 0, 2, null],
      ['gap', 0, 2, null],
    ])(
      `bounds actual iterator work and finalizes its keyset statement (${direction}, %s)`, (stop, rowCount, pullCount, expectedStop) => {
        let drafts = [tool(), tool(), tool()];
        if (stop === 'boundary') drafts = [assistant(), user()];
        if (stop === 'batch-limit') drafts = Array.from({ length: 205 }, tool);
        if (stop === 'oversized-row') drafts = [hidden(), notice('x'.repeat(1024 * 1024 + 1)), user()];
        append(direction === 'forward' ? drafts : drafts.reverse());
        if (stop === 'decode-error') db.query("UPDATE transcript_rows SET payload_json = 'invalid synthetic JSON' WHERE ordinal = 2").run();
        if (stop === 'gap') db.query('DELETE FROM transcript_rows WHERE ordinal = 2').run();
        const schema = db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all();
        const query = db.query.bind(db);
        let pulls = 0;
        let iterateSpy;
        let finalizeSpy;
        let allSpy;
        const querySpy = spyOn(db, 'query').mockImplementation(sql => {
          const statement = query(sql);
          const iterate = statement.iterate.bind(statement);
          iterateSpy = spyOn(statement, 'iterate').mockImplementation(function* (...args) {
            for (const row of iterate(...args)) { pulls++; yield row; }
          });
          allSpy = spyOn(statement, 'all').mockImplementation(() => { throw new Error('Anchor reads must iterate lazily'); });
          finalizeSpy = spyOn(statement, 'finalize');
          return statement;
        });
        try {
          const input = { direction, cursorOrdinal: direction === 'backward' ? head + 1 : 0,
            watermarkOrdinal: head, anchorsRemaining: 1 };
          const read = () => readAnchorBatch(db, VIEW, input, input, () => false);
          if (stop === 'decode-error') expect(read).toThrow();
          else if (stop === 'gap') expect(read).toThrow('noncontiguous raw interval');
          else {
            const result = read();
            expect(result.rows).toHaveLength(rowCount);
            expect(result.stop).toBe(expectedStop);
          }
          expect(querySpy).toHaveBeenCalledTimes(1);
          expect(pulls).toBe(pullCount);
          expect(allSpy).not.toHaveBeenCalled();
          expect(finalizeSpy).toHaveBeenCalledTimes(1);
          const args = [VIEW, input.cursorOrdinal, head, 200];
          expect(iterateSpy).toHaveBeenCalledWith(...args);
          const plan = query(`EXPLAIN QUERY PLAN ${querySpy.mock.calls[0][0]}`).all(...args);
          expect(plan.some(row => row.detail.includes('PRIMARY KEY'))).toBe(true);
          expect(query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
          expect(query('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
        } finally {
          iterateSpy?.mockRestore();
          allSpy?.mockRestore();
          finalizeSpy?.mockRestore();
          querySpy.mockRestore();
        }
      },
    );
  }
  it.each([1, 250, 405])('rejects a missing row at ordinal %s instead of reporting exhaustion', ordinal => {
    append(Array.from({ length: 405 }, hidden));
    db.query('DELETE FROM transcript_rows WHERE ordinal = ?').run(ordinal);
    for (const direction of ['forward', 'backward']) {
      expect(() => scan(direction, 1)).toThrow('Transcript anchor scan');
    }
  });

  it('uses the existing primary key and never changes the schema', () => {
    append([user(), tool(), assistant()]);
    const schema = db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    const plan = db.query('EXPLAIN QUERY PLAN SELECT * FROM transcript_rows WHERE view_id = ? AND ordinal < ? AND ordinal <= ? ORDER BY ordinal DESC LIMIT ?').all(VIEW, 4, 3, 200);
    expect(plan.some(row => row.detail.includes('PRIMARY KEY'))).toBe(true);
    scan('backward', 1);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  });
});
