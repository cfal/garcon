import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '../../../common/chat-types.ts';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LedgerFencedError,
  StaleTranscriptViewError,
  SubmissionConflictError,
  TranscriptLedgerStore,
  transcriptViewId,
} from '../index.ts';

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
  it('commits atomic batches with dense view-local ordinals', () => {
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

  it('rejects a mismatched submission retry without fencing the ledger', () => {
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

  it('atomically deletes the replaced view when promoting staging', () => {
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
});

function inputDetail(clientMessageId, content) {
  return {
    clientMessageId,
    message: new UserMessage(at, content),
    attachments: [],
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
