import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '../../../common/chat-types.ts';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IncompleteLedgerCheckpointError,
  LedgerFencedError,
  StaleTranscriptViewError,
  SubmissionConflictError,
  TranscriptLedgerStore,
  transcriptViewId,
} from '../index.ts';
import { frozenConversationDrafts } from '../projection.ts';

const at = '2026-08-12T00:00:00.000Z';
let root;
let store;

beforeEach(async () => {
  root = path.join(os.tmpdir(), `garcon-ledger-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId(randomUUID()),
    now: () => at,
  });
});

afterEach(async () => {
  store?.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('TranscriptLedgerStore', () => {
  it('[TLV5-L02.01-STORE-UNIT-01] commits atomic batches with dense view-local ordinals', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });

    const rows = store.append('chat-one', view.viewId, [
      provider('first'),
      provider('second'),
    ]);

    expect(rows.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(store.currentRows('chat-one').map(renderedContent)).toEqual(['first', 'second']);
    expect(store.highWatermark('chat-one')).toEqual({ viewId: view.viewId, ordinal: 2 });
  });

  it('seeds the next ordinal from durable rows when reopening a ledger', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
      rows: [provider('first'), provider('second')],
    });
    store.close();
    store = new TranscriptLedgerStore(root);

    const appended = store.append('chat-one', view.viewId, [provider('third')]);

    expect(appended.map((row) => row.ordinal)).toEqual([3]);
    expect(store.currentRows('chat-one').map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(store.highWatermark('chat-one')).toEqual({ viewId: view.viewId, ordinal: 3 });
  });

  it('rejects an invalid multi-row batch before committing without fencing the chat', () => {
    const broken = store.initializeCurrentView('broken-chat', {
      viewId: transcriptViewId('broken-view'),
      contentStartOrdinal: 1,
    });
    const healthy = store.initializeCurrentView('healthy-chat', {
      viewId: transcriptViewId('healthy-view'),
      contentStartOrdinal: 1,
    });

    expect(() => store.append('broken-chat', broken.viewId, [
      userDraft('same-id', 'one'),
      userDraft('same-id', 'two'),
    ])).toThrow('Transcript view contains duplicate client message IDs');
    expect(store.currentRows('broken-chat')).toEqual([]);

    store.append('broken-chat', broken.viewId, [provider('recovered')]);
    expect(store.currentRows('broken-chat').map(renderedContent)).toEqual(['recovered']);

    store.append('healthy-chat', healthy.viewId, [provider('still works')]);
    expect(store.currentRows('healthy-chat').map(renderedContent)).toEqual(['still works']);

  });

  it('rolls back a failed commit and fences only that chat', () => {
    const failedView = store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('failed-view'),
      contentStartOrdinal: 1,
    });
    const healthyView = store.initializeCurrentView('healthy-chat', {
      viewId: transcriptViewId('healthy-view'),
      contentStartOrdinal: 1,
    });
    const exec = Database.prototype.exec;
    let commitFailed = false;
    Database.prototype.exec = function (sql) {
      if (!commitFailed && sql === 'COMMIT') {
        commitFailed = true;
        throw new Error('injected transcript commit failure');
      }
      return exec.call(this, sql);
    };
    try {
      expect(() => store.append('failed-chat', failedView.viewId, [
        provider('must roll back one'),
        provider('must roll back two'),
      ])).toThrow(LedgerFencedError);
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitFailed).toBe(true);
    expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
    expect(store.append('healthy-chat', healthyView.viewId, [provider('still writable')])
      .map(renderedContent)).toEqual(['still writable']);

    store.close();
    store = new TranscriptLedgerStore(root);
    expect(store.currentRows('failed-chat')).toEqual([]);
    expect(store.currentRows('healthy-chat').map(renderedContent)).toEqual(['still writable']);
  });

  it('deduplicates a committed submission without redispatching it', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    const detail = inputDetail('message-one', 'hello');

    const first = store.appendInputAndCompose('chat-one', { viewId: view.viewId, at, detail });
    const retry = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at: '2026-08-12T00:00:01.000Z',
      detail,
    });

    expect(first.inserted).toBe(true);
    expect(first.prompt.map((row) => row.detail.message.content)).toEqual(['hello']);
    expect(retry).toMatchObject({ inserted: false, prompt: [] });
    expect(retry.input.ordinal).toBe(first.input.ordinal);
    expect(store.currentRows('chat-one')).toHaveLength(1);
  });

  it('[TLV5-L04.05-STORE-UNIT-01] rejects a mismatched submission retry without fencing the ledger', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('message-one', 'original'),
    });

    expect(() => store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('message-one', 'changed'),
    })).toThrow(SubmissionConflictError);

    expect(store.append('chat-one', view.viewId, [provider('healthy')])).toHaveLength(1);
  });

  it('qualifies submission retries by canonical attachment identity', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    const attachment = {
      kind: 'image',
      data: 'data:image/png;base64,YQ==',
      name: 'diagram.png',
      mimeType: 'image/png',
    };
    store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('message-one', 'same text', [attachment]),
    });

    const retry = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('message-one', 'same text', [{
        mimeType: 'image/png',
        name: 'diagram.png',
        data: 'data:image/png;base64,YQ==',
        kind: 'image',
      }]),
    });
    expect(retry).toMatchObject({ inserted: false, prompt: [] });

    expect(() => store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('message-one', 'same text', [{
        ...attachment,
        data: 'data:image/png;base64,Yg==',
      }]),
    })).toThrow(SubmissionConflictError);
    expect(store.currentRows('chat-one')).toHaveLength(1);
  });

  it('reads assistant receipt output between the submitted input and terminal row', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.append('chat-one', view.viewId, [provider('earlier')]);
    store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('message-one', 'prompt'),
    });
    store.append('chat-one', view.viewId, [
      provider('first answer'),
      { kind: 'provider-row', at, message: new BashToolUseMessage(at, 'tool-one', 'pwd') },
      provider('second answer'),
      runEnded('finished'),
      provider('late answer'),
    ]);

    expect(store.assistantMessagesForSubmission(
      'chat-one',
      view.viewId,
      'message-one',
      6,
    )).toEqual(['first answer', 'second answer']);
  });

  it('composes unanswered inputs through interruptions and stops at provider engagement', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('a', 'A'),
    });
    store.append('chat-one', view.viewId, [runEnded('interrupted')]);

    const second = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('b', 'B'),
    });
    expect(second.prompt.map((row) => row.detail.message.content)).toEqual(['A', 'B']);

    store.append('chat-one', view.viewId, [provider('answer')]);
    const third = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('c', 'C'),
    });
    expect(third.prompt.map((row) => row.detail.message.content)).toEqual(['C']);

    const steer = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: { ...inputDetail('steer', 'steer'), steer: true },
    });
    expect(steer.prompt.map((row) => row.detail.message.content)).toEqual(['steer']);
  });

  it('composes unanswered inputs through non-engagement ledger rows', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('a', 'A'),
    });
    store.append('chat-one', view.viewId, [
      {
        kind: 'notice',
        at,
        message: 'advisory',
        detail: { action: 'reload-native-history' },
      },
      session('session-one'),
      {
        kind: 'permission-resolved',
        at,
        lifecycle: {
          kind: 'resolved',
          requestId: 'permission-one',
          incarnation: 'incarnation-one',
          decision: { allow: true },
        },
      },
      {
        kind: 'permission-cancelled',
        at,
        lifecycle: {
          kind: 'cancelled',
          requestId: 'permission-two',
          incarnation: 'incarnation-two',
          reason: 'cancelled',
        },
      },
      {
        kind: 'permission-expired',
        at,
        lifecycle: {
          kind: 'expired',
          requestId: 'permission-three',
          incarnation: 'incarnation-three',
        },
      },
      {
        kind: 'agent-switch',
        at,
        detail: {
          fromAgentId: 'claude',
          toAgentId: 'codex',
          fromModel: 'haiku',
          toModel: 'gpt',
        },
      },
      runEnded('interrupted'),
    ]);

    const composed = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('b', 'B'),
    });

    expect(composed.prompt.map((row) => row.detail.message.content)).toEqual(['A', 'B']);
  });

  for (const outcome of ['finished', 'failed']) {
    it(`stops the resend scan at a ${outcome} run`, () => {
      const view = store.initializeCurrentView('chat-one', {
        viewId: transcriptViewId('view-one'),
        contentStartOrdinal: 1,
      });
      store.appendInputAndCompose('chat-one', {
        viewId: view.viewId,
        at,
        detail: inputDetail('a', 'A'),
      });
      store.append('chat-one', view.viewId, [runEnded(outcome)]);

      const composed = store.appendInputAndCompose('chat-one', {
        viewId: view.viewId,
        at,
        detail: inputDetail('b', 'B'),
      });

      expect(composed.prompt.map((row) => row.detail.message.content)).toEqual(['B']);
    });
  }

  it('collects a prior steer in the next turn after sending it alone', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
      rows: [provider('earlier answer')],
    });
    const steer = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: { ...inputDetail('steer', 'steer'), steer: true },
    });
    expect(steer.prompt.map((row) => row.detail.message.content)).toEqual(['steer']);

    const composed = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('next', 'next'),
    });

    expect(composed.prompt.map((row) => row.detail.message.content)).toEqual(['steer', 'next']);
  });

  it('does not materialize unbounded resend scans', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    const originalQuery = Database.prototype.query;
    Database.prototype.query = function query(sql) {
      const statement = originalQuery.call(this, sql);
      const isUnboundedResendScan = sql.includes('FROM transcript_rows')
        && sql.includes('ORDER BY ordinal DESC')
        && !sql.includes('LIMIT');
      if (isUnboundedResendScan) {
        statement.all = function rejectEagerScan() {
          throw new Error('Unbounded resend scans must stream rows');
        };
      }
      return statement;
    };

    try {
      store.appendInputAndCompose('chat-one', {
        viewId: view.viewId,
        at,
        detail: inputDetail('a', 'A'),
      });
      store.append('chat-one', view.viewId, [runEnded('interrupted')]);
      const second = store.appendInputAndCompose('chat-one', {
        viewId: view.viewId,
        at,
        detail: inputDetail('b', 'B'),
      });

      expect(second.prompt.map((row) => row.detail.message.content)).toEqual(['A', 'B']);
      expect(store.resendCandidates('chat-one').map(
        (row) => row.detail.message.content,
      )).toEqual(['A', 'B']);
    } finally {
      Database.prototype.query = originalQuery;
    }
  });

  it('treats every permission request as a resend boundary', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('a', 'A'),
    });
    store.append('chat-one', view.viewId, [permissionRequested()]);

    const next = store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('b', 'B'),
    });

    expect(next.prompt.map((row) => row.detail.message.content)).toEqual(['B']);
  });

  it('pages newest rows with stable keyset cursors', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
      rows: [provider('one'), provider('two'), provider('three'), provider('four'), provider('five')],
    });

    const newest = store.page('chat-one', view.viewId, 2);
    const older = store.page('chat-one', view.viewId, 2, newest.nextBefore);
    const oldest = store.page('chat-one', view.viewId, 2, older.nextBefore);

    expect(newest.rows.map(renderedContent)).toEqual(['four', 'five']);
    expect(older.rows.map(renderedContent)).toEqual(['two', 'three']);
    expect(oldest.rows.map(renderedContent)).toEqual(['one']);
    expect(oldest.nextBefore).toBeNull();
  });

  it('[TLV5-L02.05-STORE-UNIT-01] atomically deletes the replaced view when promoting staging', () => {
    const current = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('old-view'),
      contentStartOrdinal: 1,
      rows: [provider('old')],
    });
    const staged = store.stageView('chat-one', {
      viewId: transcriptViewId('new-view'),
      contentStartOrdinal: 1,
      rows: [provider('new')],
    });

    const promoted = store.replaceCurrentView('chat-one', current.viewId, staged.viewId);

    expect(promoted).toMatchObject({ viewId: staged.viewId, status: 'current' });
    expect(store.currentRows('chat-one').map(renderedContent)).toEqual(['new']);
    expect(() => store.page('chat-one', current.viewId, 10)).toThrow(StaleTranscriptViewError);

    store.close();
    const db = new Database(path.join(root, 'chat-one', 'ledger.sqlite'), {
      readonly: true,
      create: false,
    });
    expect(db.query('SELECT count(*) AS count FROM transcript_views').get().count).toBe(1);
    expect(db.query('SELECT count(*) AS count FROM transcript_rows WHERE view_id = ?').get(current.viewId).count).toBe(0);
    db.close();
  });

  it('preserves submission identity through staging and promotion', () => {
    const current = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('old-view'),
      contentStartOrdinal: 1,
      rows: [userDraft('message-one', 'old content')],
    });

    expect(() => store.stageView('chat-one', {
      viewId: transcriptViewId('invalid-stage'),
      contentStartOrdinal: 1,
      rows: [
        userDraft('message-one', 'preserved content'),
        userDraft('message-one', 'duplicate content'),
      ],
    })).toThrow('Transcript view contains duplicate client message IDs');
    expect(store.currentView('chat-one').viewId).toBe(current.viewId);
    expect(store.currentRows('chat-one')).toMatchObject([{
      kind: 'user-input',
      detail: {
        clientMessageId: 'message-one',
        message: { content: 'old content' },
      },
    }]);

    const staged = store.stageView('chat-one', {
      viewId: transcriptViewId('new-view'),
      contentStartOrdinal: 1,
      rows: [
        userDraft('message-one', 'preserved content'),
        provider('replacement answer'),
      ],
    });
    store.replaceCurrentView('chat-one', current.viewId, staged.viewId);

    const retry = store.appendInputAndCompose('chat-one', {
      viewId: staged.viewId,
      at: '2026-08-12T00:00:01.000Z',
      detail: inputDetail('message-one', 'preserved content'),
    });
    expect(retry).toMatchObject({ inserted: false, prompt: [] });
    expect(retry.input).toMatchObject({ ordinal: 1, detail: { clientMessageId: 'message-one' } });
    expect(store.currentRows('chat-one')).toHaveLength(2);
    expect(store.currentRows('chat-one').map((row) => row.ordinal)).toEqual([1, 2]);
  });

  it('reopens the complete old view when cutover fails before commit', () => {
    const current = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('old-view'),
      contentStartOrdinal: 1,
      rows: [provider('old one'), provider('old two')],
    });
    const staged = store.stageView('chat-one', {
      viewId: transcriptViewId('new-view'),
      contentStartOrdinal: 1,
      rows: [provider('new one'), provider('new two')],
    });
    const exec = Database.prototype.exec;
    let commitFailed = false;
    Database.prototype.exec = function (sql) {
      if (!commitFailed && sql === 'COMMIT') {
        commitFailed = true;
        throw new Error('injected pre-commit cutover failure');
      }
      return exec.call(this, sql);
    };
    try {
      expect(() => store.replaceCurrentView('chat-one', current.viewId, staged.viewId))
        .toThrow(LedgerFencedError);
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitFailed).toBe(true);
    expect(() => store.currentRows('chat-one')).toThrow(LedgerFencedError);

    store.close();
    store = new TranscriptLedgerStore(root);
    expect(store.currentView('chat-one').viewId).toBe(current.viewId);
    expect(store.currentRows('chat-one').map(renderedContent)).toEqual(['old one', 'old two']);
    expect(currentViewCount(root, 'chat-one')).toBe(1);
  });

  it('reopens the complete new view when cutover commit outcome is ambiguous', () => {
    const current = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('old-view'),
      contentStartOrdinal: 1,
      rows: [provider('old one'), provider('old two')],
    });
    const staged = store.stageView('chat-one', {
      viewId: transcriptViewId('new-view'),
      contentStartOrdinal: 1,
      rows: [provider('new one'), provider('new two')],
    });
    const exec = Database.prototype.exec;
    let commitBecameAmbiguous = false;
    Database.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (!commitBecameAmbiguous && sql === 'COMMIT') {
        commitBecameAmbiguous = true;
        throw new Error('injected ambiguous cutover commit');
      }
      return result;
    };
    try {
      expect(() => store.replaceCurrentView('chat-one', current.viewId, staged.viewId))
        .toThrow(LedgerFencedError);
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitBecameAmbiguous).toBe(true);
    expect(() => store.currentRows('chat-one')).toThrow(LedgerFencedError);

    store.close();
    store = new TranscriptLedgerStore(root);
    expect(store.currentView('chat-one').viewId).toBe(staged.viewId);
    expect(store.currentRows('chat-one').map(renderedContent)).toEqual(['new one', 'new two']);
    expect(currentViewCount(root, 'chat-one')).toBe(1);
  });

  it('deletes stale staging views lazily when reopening a chat', () => {
    store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('current-view'),
      contentStartOrdinal: 1,
    });
    store.stageView('chat-one', {
      viewId: transcriptViewId('abandoned-stage'),
      contentStartOrdinal: 1,
      rows: [provider('abandoned')],
    });
    store.close();
    store = new TranscriptLedgerStore(root);

    expect(store.currentView('chat-one').viewId).toBe('current-view');

    store.close();
    const db = new Database(path.join(root, 'chat-one', 'ledger.sqlite'), {
      readonly: true,
      create: false,
    });
    expect(db.query("SELECT count(*) AS count FROM transcript_views WHERE status = 'staging'").get().count).toBe(0);
    db.close();
  });

  it('derives the current native session from the content-start boundary', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
      rows: [session('native-one')],
    });
    expect(store.currentSession('chat-one').detail.agentSessionId).toBe('native-one');

    store.advanceContentStart('chat-one', view.viewId, 2);
    expect(store.currentSession('chat-one')).toBeNull();

    store.append('chat-one', view.viewId, [session('native-two')]);
    expect(store.currentSession('chat-one').detail.agentSessionId).toBe('native-two');
  });

  it('verifies a complete WAL checkpoint at the current watermark', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
      rows: [provider('one')],
    });

    const checkpoint = store.checkpointForHandoff('chat-one');

    expect(checkpoint.viewId).toBe(view.viewId);
    expect(checkpoint.ordinal).toBe(1);
    expect(checkpoint.logFrames).toBe(checkpoint.checkpointedFrames);
  });

  it('rejects an incomplete handoff checkpoint without fencing the ledger', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
      rows: [provider('one')],
    });
    const query = Database.prototype.query;
    let checkpointAttempted = false;
    Database.prototype.query = function (sql) {
      if (!checkpointAttempted && sql === 'PRAGMA wal_checkpoint(FULL)') {
        checkpointAttempted = true;
        return {
          get: () => ({ busy: 1, log: 3, checkpointed: 2 }),
        };
      }
      return query.call(this, sql);
    };
    try {
      expect(() => store.checkpointForHandoff('chat-one'))
        .toThrow(IncompleteLedgerCheckpointError);
    } finally {
      Database.prototype.query = query;
    }

    expect(checkpointAttempted).toBe(true);
    expect(store.append('chat-one', view.viewId, [provider('two')]).map(renderedContent))
      .toEqual(['two']);
    expect(store.checkpointForHandoff('chat-one')).toMatchObject({
      viewId: view.viewId,
      ordinal: 2,
    });
  });

  it('validates user_version and isolates corrupt databases by chat', () => {
    store.initializeCurrentView('bad-chat', {
      viewId: transcriptViewId('bad-view'),
      contentStartOrdinal: 1,
    });
    store.initializeCurrentView('good-chat', {
      viewId: transcriptViewId('good-view'),
      contentStartOrdinal: 1,
    });
    store.close();

    const db = new Database(path.join(root, 'bad-chat', 'ledger.sqlite'));
    db.exec('PRAGMA user_version = 999');
    db.close();
    store = new TranscriptLedgerStore(root);

    expect(() => store.currentView('bad-chat')).toThrow(LedgerFencedError);
    expect(store.currentView('good-chat').viewId).toBe('good-view');
  });

  it('evicts idle connections and removes chat directories cleanly', async () => {
    store.close();
    store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
    store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.initializeCurrentView('chat-two', {
      viewId: transcriptViewId('view-two'),
      contentStartOrdinal: 1,
    });

    store.deleteChat('chat-one');

    expect(await fs.stat(path.join(root, 'chat-one')).catch(() => null)).toBeNull();
    expect(store.currentView('chat-two').viewId).toBe('view-two');
  });

  it('attributes an eviction checkpoint failure to the evicted chat', () => {
    store.close();
    store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
    store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });

    const exec = Database.prototype.exec;
    let checkpointFailed = false;
    Database.prototype.exec = function (sql) {
      if (!checkpointFailed && sql === 'PRAGMA wal_checkpoint(PASSIVE)') {
        checkpointFailed = true;
        throw new Error('injected eviction checkpoint failure');
      }
      return exec.call(this, sql);
    };
    try {
      const opened = store.initializeCurrentView('chat-two', {
        viewId: transcriptViewId('view-two'),
        contentStartOrdinal: 1,
      });

      expect(checkpointFailed).toBe(true);
      expect(opened.viewId).toBe('view-two');
      expect(store.currentView('chat-two').viewId).toBe('view-two');
      expect(() => store.currentView('chat-one')).toThrow(LedgerFencedError);
    } finally {
      Database.prototype.exec = exec;
    }
  });

  it('[TLV5-L11.04-STORE-UNIT-01] attributes an eviction close failure and retries that handle on shutdown', () => {
    store.close();
    store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
    store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });

    const close = Database.prototype.close;
    const attempts = new WeakMap();
    let failedDatabase = null;
    Database.prototype.close = function () {
      const count = (attempts.get(this) ?? 0) + 1;
      attempts.set(this, count);
      if (failedDatabase === null) {
        failedDatabase = this;
        throw new Error('injected eviction close failure');
      }
      return close.call(this);
    };
    try {
      const opened = store.initializeCurrentView('chat-two', {
        viewId: transcriptViewId('view-two'),
        contentStartOrdinal: 1,
      });

      expect(opened.viewId).toBe('view-two');
      expect(store.currentView('chat-two').viewId).toBe('view-two');
      expect(() => store.currentView('chat-one')).toThrow(LedgerFencedError);
      expect(attempts.get(failedDatabase)).toBe(1);

      store.close();

      expect(attempts.get(failedDatabase)).toBe(2);
    } finally {
      Database.prototype.close = close;
      if (failedDatabase !== null && attempts.get(failedDatabase) === 1) {
        close.call(failedDatabase);
      }
    }
  });

  it('fences a requested chat open failure without fencing the cached chat', () => {
    store.close();
    store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
    store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });

    const exec = Database.prototype.exec;
    let openFailed = false;
    Database.prototype.exec = function (sql) {
      if (!openFailed && sql === 'PRAGMA journal_mode = WAL') {
        openFailed = true;
        throw new Error('injected requested-chat open failure');
      }
      return exec.call(this, sql);
    };
    try {
      expect(() => store.initializeCurrentView('chat-two', {
        viewId: transcriptViewId('view-two'),
        contentStartOrdinal: 1,
      })).toThrow(LedgerFencedError);

      expect(openFailed).toBe(true);
      expect(store.currentView('chat-one').viewId).toBe('view-one');
      expect(() => store.currentView('chat-two')).toThrow(LedgerFencedError);
    } finally {
      Database.prototype.exec = exec;
    }
  });

  it('removes only unregistered target ledgers during startup cleanup', async () => {
    store.initializeCurrentView('registered-chat', {
      viewId: transcriptViewId('registered-view'),
      contentStartOrdinal: 1,
    });
    store.initializeCurrentView('orphan-chat', {
      viewId: transcriptViewId('orphan-view'),
      contentStartOrdinal: 1,
    });

    expect(store.removeUnregisteredChatDirectories(new Set(['registered-chat'])))
      .toEqual(['orphan-chat']);
    expect(store.currentView('registered-chat')?.viewId).toBe('registered-view');
    expect(await fs.stat(path.join(root, 'orphan-chat')).catch(() => null)).toBeNull();
  });

  it('carries the agent switch boundary through a reload', () => {
    const view = store.initializeCurrentView('chat-one', {
      contentStartOrdinal: 1,
      rows: [
        provider('before handoff'),
        {
          kind: 'agent-switch',
          at,
          detail: {
            fromAgentId: 'claude',
            toAgentId: 'codex',
            fromModel: 'sonnet',
            toModel: 'gpt',
          },
          providerMeta: null,
        },
      ],
    });

    const carried = frozenConversationDrafts(store.currentRows('chat-one'));
    const staged = store.stageView('chat-one', {
      viewId: transcriptViewId('reloaded-view'),
      contentStartOrdinal: carried.length + 1,
      rows: carried,
    });
    store.replaceCurrentView('chat-one', view.viewId, staged.viewId);

    expect(store.currentRows('chat-one').map((row) => row.kind))
      .toEqual(['provider-row', 'agent-switch']);
    expect(store.currentRows('chat-one').at(-1)).toMatchObject({
      kind: 'agent-switch',
      detail: { fromAgentId: 'claude', toAgentId: 'codex' },
    });
  });
});

function inputDetail(clientMessageId, content, attachments = []) {
  return {
    clientMessageId,
    message: new UserMessage(at, content),
    attachments,
    steer: false,
  };
}

function userDraft(clientMessageId, content) {
  return { kind: 'user-input', at, detail: inputDetail(clientMessageId, content) };
}

function provider(content) {
  return { kind: 'provider-row', at, message: new AssistantMessage(at, content) };
}

function runEnded(outcome) {
  return { kind: 'run-ended', at, outcome, origin: 'core' };
}

function session(agentSessionId) {
  return {
    kind: 'session',
    at,
    detail: {
      agentSessionId,
      nativeSession: {
        ownerId: 'fixture',
        schemaVersion: 1,
        value: { path: `/tmp/${agentSessionId}.jsonl` },
      },
      nativeSeedReceipt: null,
    },
  };
}

function permissionRequested() {
  return {
    kind: 'permission-requested',
    at,
    lifecycle: {
      kind: 'requested',
      requestId: 'permission-one',
      incarnation: 'incarnation-one',
      requestedTool: new BashToolUseMessage(at, 'tool-one', 'pwd'),
      options: [{ id: 'allow', label: 'Allow' }],
    },
  };
}

function renderedContent(row) {
  return row.kind === 'provider-row' ? row.message.content : null;
}

function currentViewCount(ledgerRoot, chatId) {
  const db = new Database(path.join(ledgerRoot, chatId, 'ledger.sqlite'), {
    readonly: true,
    create: false,
  });
  try {
    return db.query("SELECT count(*) AS count FROM transcript_views WHERE status = 'current'")
      .get().count;
  } finally {
    db.close();
  }
}
