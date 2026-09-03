import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '../../../common/chat-types.ts';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
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
import {
  chatIdRequestNoticeDraft,
  interAgentSendRequestNoticeDraft,
} from '../garcon-command-request.ts';
import { decodeLedgerRow } from '../codec.ts';
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
  it('recreates a ledger root removed after store construction', async () => {
    await fs.rm(root, { recursive: true, force: true });

    const current = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });

    expect(store.currentView('chat-one')).toEqual(current);
  });

  it('rejects a ledger root redirected after store construction', async () => {
    const outsideDirectory = `${root}-outside`;
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(outsideDirectory);
    await fs.symlink(outsideDirectory, root, 'dir');

    try {
      expect(() => store.currentView('redirected')).toThrow(LedgerFencedError);
      await expect(fs.access(path.join(outsideDirectory, 'redirected', 'ledger.sqlite')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('rejects pre-created symlink directories for chat ledgers', async () => {
    const outsideDirectory = `${root}-outside`;
    await fs.mkdir(outsideDirectory);
    await fs.symlink(outsideDirectory, path.join(root, 'redirected'), 'dir');

    try {
      expect(() => store.currentView('redirected')).toThrow(LedgerFencedError);
      await expect(fs.access(path.join(outsideDirectory, 'ledger.sqlite')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('[TLV5-SEARCH.11-STORE-01] probes existing views without materializing a missing ledger', async () => {
    const missingPath = path.join(root, 'never-opened', 'ledger.sqlite');
    expect(store.existingCurrentView('never-opened')).toBeNull();
    await expect(fs.stat(missingPath)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(store.currentView('schema-only')).toBeNull();
    const current = store.initializeCurrentView('adopted', {
      viewId: transcriptViewId('adopted-view'),
      contentStartOrdinal: 1,
    });
    store.close();
    store = new TranscriptLedgerStore(root);

    expect(store.existingCurrentView('schema-only')).toBeNull();
    expect(store.existingCurrentView('adopted')).toEqual(current);
  });

  it('treats a ledger removed during its existence probe as absent', async () => {
    const chatDirectory = path.join(root, 'disappearing');
    await fs.mkdir(chatDirectory, { recursive: true });
    await fs.writeFile(path.join(chatDirectory, 'ledger.sqlite'), 'present');
    const stat = spyOn(nodeFs, 'statSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ledger disappeared'), { code: 'ENOENT' });
    });

    try {
      expect(store.existingCurrentView('disappearing')).toBeNull();
    } finally {
      stat.mockRestore();
    }
  });

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

  it('[TLV5-CHAT-ID-DISCOVERY.01-STORE-RESTART-01] preserves a hidden chat ID request row when reopening a ledger', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.append('chat-one', view.viewId, [chatIdRequestNoticeDraft(at)]);
    store.close();
    store = new TranscriptLedgerStore(root);

    expect(store.currentRows('chat-one')).toMatchObject([{
      ordinal: 1,
      kind: 'notice',
      at,
      message: 'Agent requested chat ID',
      detail: { type: 'chat-id-request' },
      providerMeta: null,
    }]);
  });

  it('preserves hidden inter-agent command evidence when reopening a ledger', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.append('chat-one', view.viewId, [interAgentSendRequestNoticeDraft(at, {
      recipients: ['1787974832309199'],
      hideSender: true,
      body: 'message body',
    })]);
    store.close();
    store = new TranscriptLedgerStore(root);

    expect(store.currentRows('chat-one')).toMatchObject([{
      ordinal: 1,
      kind: 'notice',
      at,
      message: 'Agent requested inter-agent message delivery',
      detail: {
        type: 'inter-agent-send-request',
        recipients: ['1787974832309199'],
        hideSender: true,
        body: 'message body',
      },
      providerMeta: null,
    }]);
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

  it('rolls back a failed commit while preserving reads and fencing later writes', () => {
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
    let failure;
    try {
      store.append('failed-chat', failedView.viewId, [
        provider('must roll back one'),
        provider('must roll back two'),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitFailed).toBe(true);
    expect(failure).toBeInstanceOf(LedgerFencedError);
    expect(failure.cause).toMatchObject({ message: 'injected transcript commit failure' });
    expect(store.currentRows('failed-chat')).toEqual([]);
    expect(() => store.append('failed-chat', failedView.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
    expect(store.append('healthy-chat', healthyView.viewId, [provider('still writable')])
      .map(renderedContent)).toEqual(['still writable']);

    store.close();
    store = new TranscriptLedgerStore(root);
    expect(store.currentRows('failed-chat')).toEqual([]);
    expect(store.currentRows('healthy-chat').map(renderedContent)).toEqual(['still writable']);
  });

  it('preserves the primary write failure when SQLite already ended the transaction', () => {
    const view = store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('failed-view'),
      contentStartOrdinal: 1,
    });
    const exec = Database.prototype.exec;
    let commitFailed = false;
    Database.prototype.exec = function (sql) {
      if (!commitFailed && sql === 'COMMIT') {
        commitFailed = true;
        exec.call(this, 'ROLLBACK');
        throw Object.assign(new Error('injected primary SQLite failure'), { code: 'SQLITE_FULL' });
      }
      return exec.call(this, sql);
    };
    let failure;
    try {
      store.append('failed-chat', view.viewId, [provider('must not commit')]);
    } catch (error) {
      failure = error;
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitFailed).toBe(true);
    expect(failure).toBeInstanceOf(LedgerFencedError);
    expect(failure.cause).toMatchObject({
      message: 'injected primary SQLite failure',
      code: 'SQLITE_FULL',
    });
    expect(store.currentRows('failed-chat')).toEqual([]);
    expect(() => store.append('failed-chat', view.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
  });

  it('fences reads when rollback fails and leaves a failed write transaction active', () => {
    const view = store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('failed-view'),
      contentStartOrdinal: 1,
    });
    const exec = Database.prototype.exec;
    let commitFailed = false;
    let rollbackFailed = false;
    Database.prototype.exec = function (sql) {
      if (!commitFailed && sql === 'COMMIT') {
        commitFailed = true;
        throw new Error('injected transcript commit failure');
      }
      if (sql === 'ROLLBACK') {
        rollbackFailed = true;
        throw new Error('injected transcript rollback failure');
      }
      return exec.call(this, sql);
    };
    let failure;
    try {
      store.append('failed-chat', view.viewId, [provider('must stay unreadable')]);
    } catch (error) {
      failure = error;
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitFailed).toBe(true);
    expect(rollbackFailed).toBe(true);
    expect(failure).toBeInstanceOf(LedgerFencedError);
    expect(failure.cause).toMatchObject({
      message: 'injected transcript commit failure',
      rollbackFailure: { message: 'injected transcript rollback failure' },
    });
    expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
    expect(() => store.append('failed-chat', view.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
    closeStoreAfterInjectedRollbackFailure();
  });

  it('fences reads when a completed rollback reports SQLite corruption', () => {
    const view = store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('failed-view'),
      contentStartOrdinal: 1,
    });
    const exec = Database.prototype.exec;
    let commitFailed = false;
    let rollbackReportedCorruption = false;
    Database.prototype.exec = function (sql) {
      if (!commitFailed && sql === 'COMMIT') {
        commitFailed = true;
        throw Object.assign(new Error('injected primary SQLite failure'), { code: 'SQLITE_FULL' });
      }
      if (sql === 'ROLLBACK') {
        rollbackReportedCorruption = true;
        exec.call(this, sql);
        throw Object.assign(new Error('injected rollback corruption'), { code: 'SQLITE_CORRUPT' });
      }
      return exec.call(this, sql);
    };
    let failure;
    try {
      store.append('failed-chat', view.viewId, [provider('must stay unreadable')]);
    } catch (error) {
      failure = error;
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitFailed).toBe(true);
    expect(rollbackReportedCorruption).toBe(true);
    expect(failure).toBeInstanceOf(LedgerFencedError);
    expect(failure.cause).toMatchObject({
      message: 'injected primary SQLite failure',
      code: 'SQLITE_FULL',
      rollbackFailure: {
        message: 'injected rollback corruption',
        code: 'SQLITE_CORRUPT',
      },
    });
    expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
    expect(() => store.append('failed-chat', view.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
  });

  it('fences domain write failures when rollback fails and leaves the transaction active', () => {
    const current = store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('old-view'),
      contentStartOrdinal: 1,
      rows: [provider('old')],
    });
    const staged = store.stageView('failed-chat', {
      viewId: transcriptViewId('new-view'),
      contentStartOrdinal: 1,
      rows: [provider('new')],
    });
    const exec = Database.prototype.exec;
    const query = Database.prototype.query;
    let promotionFailed = false;
    let rollbackFailed = false;
    Database.prototype.exec = function (sql) {
      if (sql === 'ROLLBACK') {
        rollbackFailed = true;
        throw new Error('injected cutover rollback failure');
      }
      return exec.call(this, sql);
    };
    Database.prototype.query = function (sql) {
      if (!promotionFailed && sql.includes("UPDATE transcript_views SET status = 'current'")) {
        return {
          run() {
            promotionFailed = true;
            return { changes: 0 };
          },
        };
      }
      return query.call(this, sql);
    };
    let failure;
    try {
      store.replaceCurrentView('failed-chat', current.viewId, staged.viewId);
    } catch (error) {
      failure = error;
    } finally {
      Database.prototype.exec = exec;
      Database.prototype.query = query;
    }

    expect(promotionFailed).toBe(true);
    expect(rollbackFailed).toBe(true);
    expect(failure).toBeInstanceOf(LedgerFencedError);
    expect(failure.cause).toMatchObject({
      name: 'LedgerSchemaError',
      message: 'Transcript staging promotion failed',
      rollbackFailure: { message: 'injected cutover rollback failure' },
    });
    expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
    expect(() => store.append('failed-chat', current.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
    closeStoreAfterInjectedRollbackFailure();
  });

  it('keeps a ledger query failure fenced for both reads and writes', () => {
    const view = store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('failed-view'),
      contentStartOrdinal: 1,
      rows: [provider('durable row')],
    });
    const query = Database.prototype.query;
    let queryFailed = false;
    Database.prototype.query = function (sql) {
      if (!queryFailed && sql.includes('FROM transcript_rows WHERE view_id = ? ORDER BY ordinal')) {
        queryFailed = true;
        throw new Error('injected transcript query failure');
      }
      return query.call(this, sql);
    };
    try {
      expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
    } finally {
      Database.prototype.query = query;
    }

    expect(queryFailed).toBe(true);
    expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
    expect(() => store.append('failed-chat', view.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
  });

  it('[TLV5-L11.01-STORE-UNIT-02] read-fences a query failure raised inside a write workflow', () => {
    const view = store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('failed-view'),
      contentStartOrdinal: 1,
    });
    const query = Database.prototype.query;
    let queryFailed = false;
    Database.prototype.query = function (sql) {
      if (!queryFailed && sql.includes('WHERE view_id = ? AND client_message_id = ?')) {
        queryFailed = true;
        throw Object.assign(new Error('injected transcript query failure'), {
          code: 'SQLITE_IOERR',
        });
      }
      return query.call(this, sql);
    };
    try {
      expect(() => store.appendInputAndCompose('failed-chat', {
        viewId: view.viewId,
        at,
        detail: inputDetail('failed-message', 'must not append'),
      })).toThrow(LedgerFencedError);
    } finally {
      Database.prototype.query = query;
    }

    expect(queryFailed).toBe(true);
    expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
    expect(() => store.append('failed-chat', view.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
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

  it('[TLV5-CHAT-ROW.02-STORE-UNIT-01] appends and deduplicates chat rows without fencing', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    const message = '  notice content\n';
    const submittedNotice = chatRowDetail('chat-row-1', 'notice', '  Deployment  ');
    const notice = chatRowDetail('chat-row-1', 'notice', 'Deployment');

    const first = store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message,
      detail: submittedNotice,
    });
    const retry = store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at: '2026-08-12T00:00:01.000Z',
      message,
      detail: notice,
    });

    expect(first).toMatchObject({ inserted: true, row: { ordinal: 1, at, message, detail: notice } });
    expect(retry).toMatchObject({ inserted: false, row: { ordinal: 1, at, message, detail: notice } });
    expect(() => store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message,
      detail: chatRowDetail('chat-row-1', 'notice', 'Different title'),
    })).toThrow(SubmissionConflictError);
    expect(() => store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message,
      detail: chatRowDetail('chat-row-1', 'notice', 'Deployment', 'markdown'),
    })).toThrow(SubmissionConflictError);
    expect(() => store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message,
      detail: chatRowDetail('chat-row-1', 'notice', 'Deployment', 'plain', 'collapsed'),
    })).toThrow(SubmissionConflictError);
    expect(() => store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message,
      detail: chatRowDetail('chat-row-1', {
        style: 'custom',
        customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
      }, 'Deployment'),
    })).toThrow(SubmissionConflictError);
    expect(() => store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message: 'changed',
      detail: chatRowDetail('chat-row-1', 'error', 'Deployment'),
    })).toThrow(SubmissionConflictError);
    expect(() => store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('chat-row-1', 'user collision'),
    })).toThrow(SubmissionConflictError);

    const second = store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message,
      detail: chatRowDetail('chat-row-2', 'info'),
    });
    expect(second).toMatchObject({ inserted: true, row: { ordinal: 2 } });
    expect(store.currentRows('chat-one')).toHaveLength(2);

    store.close();
    store = new TranscriptLedgerStore(root);
    expect(store.currentRows('chat-one')).toMatchObject([
      { kind: 'notice', ordinal: 1, message, detail: notice },
      {
        kind: 'notice',
        ordinal: 2,
        message,
        detail: {
          clientMessageId: 'chat-row-2',
          presentation: { style: 'info' },
          format: 'plain',
          title: null,
        },
      },
    ]);
  });

  it('rejects malformed durable CLI row titles without fencing the ledger', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });

    expect(() => store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message: 'invalid title',
      detail: chatRowDetail('chat-row-1', 'notice', 'x'.repeat(121)),
    })).toThrow('title must be at most 120 characters');
    expect(store.currentRows('chat-one')).toEqual([]);
    expect(store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message: 'healthy row',
      detail: chatRowDetail('chat-row-2', 'notice'),
    }).inserted).toBe(true);
  });

  it('rejects malformed stored CLI row detail at the codec boundary', () => {
    const storedRow = (detail, overrides = {}) => ({
      view_id: 'view-one',
      ordinal: 1,
      kind: 'notice',
      at,
      client_message_id: 'chat-row-1',
      payload_json: JSON.stringify({
        providerMeta: null,
        value: { message: 'stored row', detail },
      }),
      ...overrides,
    });
    const valid = chatRowDetail('chat-row-1', 'notice');

    expect(decodeLedgerRow(storedRow(valid))).toMatchObject({
      kind: 'notice',
      detail: valid,
    });
    expect(decodeLedgerRow(storedRow({
      type: 'cli-row',
      clientMessageId: 'chat-row-1',
      presentation: 'error',
      title: null,
    }))).toMatchObject({
      kind: 'notice',
      detail: {
        presentation: { style: 'error' },
        format: 'plain',
        disclosure: 'expanded',
      },
    });
    expect(() => decodeLedgerRow(storedRow({ ...valid, title: undefined })))
      .toThrow('Stored chat row detail is invalid');
    expect(() => decodeLedgerRow(storedRow({ ...valid, title: '' })))
      .toThrow('Stored chat row detail is invalid');
    expect(() => decodeLedgerRow(storedRow({ ...valid, title: 7 })))
      .toThrow('Stored chat row detail is invalid');
    expect(() => decodeLedgerRow(storedRow({ ...valid, clientMessageId: 'other' })))
      .toThrow('Stored chat row identity does not match its payload');
    expect(() => decodeLedgerRow(storedRow(valid, {
      payload_json: JSON.stringify({
        providerMeta: { source: 'provider' },
        value: { message: 'stored row', detail: valid },
      }),
    }))).toThrow('Stored chat row provider metadata must be null');
  });

  it('rejects a chat row collision with an existing user input without fencing', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });
    store.appendInputAndCompose('chat-one', {
      viewId: view.viewId,
      at,
      detail: inputDetail('message-one', 'user input'),
    });

    expect(() => store.appendChatRow('chat-one', {
      viewId: view.viewId,
      at,
      message: 'error content',
      detail: chatRowDetail('message-one', 'error'),
    })).toThrow(SubmissionConflictError);
    expect(store.append('chat-one', view.viewId, [provider('still healthy')])).toHaveLength(1);
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
        detail: { type: 'ordinary-notice' },
      },
      session('session-one'),
      {
        kind: 'permission-resolved',
        at,
        lifecycle: {
          kind: 'resolved',
          permissionOccurrenceId: 'incarnation-one',
          decision: { allow: true },
        },
      },
      {
        kind: 'permission-cancelled',
        at,
        lifecycle: {
          kind: 'cancelled',
          permissionOccurrenceId: 'incarnation-two',
          reason: 'cancelled',
        },
      },
      {
        kind: 'permission-expired',
        at,
        lifecycle: {
          kind: 'expired',
          permissionOccurrenceId: 'incarnation-three',
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

    const query = Database.prototype.query;
    const transcriptRowSelects = [];
    Database.prototype.query = function (sql) {
      if (/^\s*SELECT[\s\S]*\bFROM\s+transcript_rows\b/i.test(sql)) {
        transcriptRowSelects.push(sql);
      }
      return query.call(this, sql);
    };
    let newest;
    try {
      newest = store.page('chat-one', view.viewId, 2);
    } finally {
      Database.prototype.query = query;
    }
    const older = store.page('chat-one', view.viewId, 2, newest.nextBefore);
    const oldest = store.page('chat-one', view.viewId, 2, older.nextBefore);

    expect(newest.rows.map(renderedContent)).toEqual(['four', 'five']);
    expect(transcriptRowSelects).toHaveLength(1);
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

  it('rehydrates the complete old view when cutover fails before commit', () => {
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
    expect(store.currentView('chat-one').viewId).toBe(current.viewId);
    expect(store.currentRows('chat-one').map(renderedContent)).toEqual(['old one', 'old two']);
    expect(() => store.append('chat-one', current.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);

    store.close();
    store = new TranscriptLedgerStore(root);
    expect(store.currentView('chat-one').viewId).toBe(current.viewId);
    expect(store.currentRows('chat-one').map(renderedContent)).toEqual(['old one', 'old two']);
    expect(currentViewCount(root, 'chat-one')).toBe(1);
  });

  it('rehydrates the complete new view when cutover commit outcome is ambiguous', () => {
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
    expect(store.currentView('chat-one').viewId).toBe(staged.viewId);
    expect(store.currentRows('chat-one').map(renderedContent)).toEqual(['new one', 'new two']);
    expect(() => store.append('chat-one', staged.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);

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

  it('[TLV5-L11.05-STORE-UNIT-03] rejects a handoff checkpoint after a write failure', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
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
      expect(() => store.append('chat-one', view.viewId, [provider('must roll back')]))
        .toThrow(LedgerFencedError);
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitFailed).toBe(true);
    expect(store.currentRows('chat-one')).toEqual([]);
    expect(() => store.checkpointForHandoff('chat-one')).toThrow(LedgerFencedError);
  });

  it('read-fences a handoff checkpoint query failure', () => {
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
      rows: [provider('durable row')],
    });
    const query = Database.prototype.query;
    let checkpointFailed = false;
    Database.prototype.query = function (sql) {
      if (!checkpointFailed && sql === 'PRAGMA wal_checkpoint(FULL)') {
        checkpointFailed = true;
        throw new Error('injected checkpoint query failure');
      }
      return query.call(this, sql);
    };
    try {
      expect(() => store.checkpointForHandoff('chat-one')).toThrow(LedgerFencedError);
    } finally {
      Database.prototype.query = query;
    }

    expect(checkpointFailed).toBe(true);
    expect(() => store.currentRows('chat-one')).toThrow(LedgerFencedError);
    expect(() => store.append('chat-one', view.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
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

  it('[TLV5-L11.05-STORE-UNIT-02] preserves a write fence across LRU eviction', () => {
    store.close();
    store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
    const view = store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('failed-view'),
      contentStartOrdinal: 1,
    });
    const exec = Database.prototype.exec;
    let commitBecameAmbiguous = false;
    Database.prototype.exec = function (sql) {
      if (!commitBecameAmbiguous && sql === 'COMMIT') {
        commitBecameAmbiguous = true;
        exec.call(this, sql);
        throw new Error('injected ambiguous transcript commit');
      }
      return exec.call(this, sql);
    };
    try {
      expect(() => store.append('failed-chat', view.viewId, [provider('durable unknown outcome')]))
        .toThrow(LedgerFencedError);
    } finally {
      Database.prototype.exec = exec;
    }

    expect(commitBecameAmbiguous).toBe(true);
    expect(store.currentRows('failed-chat').map(renderedContent)).toEqual(['durable unknown outcome']);
    store.initializeCurrentView('evicting-chat', {
      viewId: transcriptViewId('evicting-view'),
      contentStartOrdinal: 1,
    });

    expect(() => store.append('failed-chat', view.viewId, [provider('must stay fenced')]))
      .toThrow(LedgerFencedError);
  });

  it('[TLV5-L11.01-STORE-UNIT-03] preserves a read fence across LRU eviction', () => {
    store.close();
    store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
    store.initializeCurrentView('failed-chat', {
      viewId: transcriptViewId('failed-view'),
      contentStartOrdinal: 1,
      rows: [provider('durable row')],
    });
    const query = Database.prototype.query;
    let queryFailed = false;
    Database.prototype.query = function (sql) {
      if (!queryFailed && sql.includes('FROM transcript_rows WHERE view_id = ? ORDER BY ordinal')) {
        queryFailed = true;
        throw Object.assign(new Error('injected transcript query corruption'), {
          code: 'SQLITE_CORRUPT',
        });
      }
      return query.call(this, sql);
    };
    try {
      expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
    } finally {
      Database.prototype.query = query;
    }

    expect(queryFailed).toBe(true);
    store.initializeCurrentView('evicting-chat', {
      viewId: transcriptViewId('evicting-view'),
      contentStartOrdinal: 1,
    });

    expect(() => store.currentRows('failed-chat')).toThrow(LedgerFencedError);
  });

  it('[TLV5-L11.06-STORE-UNIT-01] does not fence an evicted chat after a passive checkpoint failure', () => {
    store.close();
    store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
    const view = store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
      rows: [provider('durable row')],
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
    let opened;
    try {
      opened = store.initializeCurrentView('chat-two', {
        viewId: transcriptViewId('view-two'),
        contentStartOrdinal: 1,
      });
    } finally {
      Database.prototype.exec = exec;
    }

    expect(checkpointFailed).toBe(true);
    expect(opened.viewId).toBe('view-two');
    expect(store.currentView('chat-two').viewId).toBe('view-two');
    store.append('chat-one', view.viewId, [provider('later row')]);
    expect(store.currentRows('chat-one').map(renderedContent)).toEqual([
      'durable row',
      'later row',
    ]);
  });

  it('[TLV5-L11.06-STORE-UNIT-02] completes chat deletion after a passive checkpoint failure', () => {
    store.initializeCurrentView('chat-one', {
      viewId: transcriptViewId('view-one'),
      contentStartOrdinal: 1,
    });

    const exec = Database.prototype.exec;
    let checkpointFailed = false;
    Database.prototype.exec = function (sql) {
      if (!checkpointFailed && sql === 'PRAGMA wal_checkpoint(PASSIVE)') {
        checkpointFailed = true;
        throw new Error('injected deletion checkpoint failure');
      }
      return exec.call(this, sql);
    };
    try {
      store.deleteChat('chat-one');
    } finally {
      Database.prototype.exec = exec;
    }

    expect(checkpointFailed).toBe(true);
    expect(nodeFs.existsSync(path.join(root, 'chat-one'))).toBe(false);
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

  it('removes unregistered symlinks without touching their targets', async () => {
    const outsideDirectory = `${root}-orphan-target`;
    await fs.mkdir(outsideDirectory);
    await fs.symlink(outsideDirectory, path.join(root, 'orphan-link'), 'dir');

    try {
      expect(store.removeUnregisteredChatDirectories(new Set())).toEqual(['orphan-link']);
      await expect(fs.lstat(path.join(root, 'orphan-link'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(outsideDirectory)).resolves.toBeDefined();
    } finally {
      await fs.rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('leaves non-directory files in the ledger root untouched', async () => {
    const filePath = path.join(root, 'orphan-file');
    await fs.writeFile(filePath, 'not a chat directory');

    expect(store.removeUnregisteredChatDirectories(new Set())).toEqual([]);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('not a chat directory');
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

function chatRowDetail(
  clientMessageId,
  presentation,
  title = null,
  format = 'plain',
  disclosure = 'expanded',
) {
  return {
    type: 'cli-row',
    clientMessageId,
    presentation: typeof presentation === 'string' ? { style: presentation } : presentation,
    format,
    disclosure,
    title,
  };
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
      permissionOccurrenceId: 'incarnation-one',
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

function closeStoreAfterInjectedRollbackFailure() {
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (sql) {
    if (sql === 'PRAGMA wal_checkpoint(PASSIVE)' && this.inTransaction) {
      exec.call(this, 'ROLLBACK');
    }
    return exec.call(this, sql);
  };
  try {
    store.close();
  } finally {
    Database.prototype.exec = exec;
    store = null;
  }
}
