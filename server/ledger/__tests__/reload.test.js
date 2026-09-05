import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, ErrorMessage, UserMessage } from '../../../common/chat-types.ts';
import { TranscriptAdoptionService } from '../adoption.ts';
import { TranscriptReloadService } from '../reload.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { LedgerFencedError } from '../errors.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('TranscriptReloadService', () => {
  it('[TLV5-L10.02-CORE-UNIT-01] atomically repeats replacement while preserving one frozen conversation prefix', async () => {
    await withReload(async ({ ledger, reload, lease, replacementLease, oldViewId }) => {
      const firstReplacement = await reload.reload('chat-1');
      const firstReplacementLease = replacementLease.current;
      const replacement = await reload.reload('chat-1');
      const rows = ledger.currentRows('chat-1');

      expect(replacement.viewId).not.toBe(oldViewId);
      expect(replacement.viewId).not.toBe(firstReplacement.viewId);
      expect(replacement.contentStartOrdinal).toBe(3);
      expect(rows.map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
        'user-input',
        'provider-row',
      ]);
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
        'native prompt',
        'native answer',
      ]);
      expect(
        rows.filter((row) => row.kind === 'user-input').map((row) => row.detail.clientMessageId),
      ).toEqual(['frozen-1', null]);
      expect(() => ledger.rowsAfter('chat-1', oldViewId, 0)).toThrow();
      expect(() => ledger.rowsAfter('chat-1', firstReplacement.viewId, 0)).toThrow();
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-1');
      expect(lease.closed).toBe(true);
      expect(firstReplacementLease?.closed).toBe(true);
      expect(replacementLease.current?.closed).toBe(false);
    });
  });

  it('rejects queued work before closing the current producer', async () => {
    await withReload(async ({ ledger, reload, lease, execution }) => {
      execution.queueEntries = [{ id: 'queued-1' }];

      await expect(reload.reload('chat-1')).rejects.toMatchObject({ code: 'CHAT_RUNNING' });
      expect(lease.closed).toBe(false);
      expect(ledger.currentView('chat-1')?.viewId).toBe('view-1');
    });
  });

  it('[TLV5-ADOPT.08-RELOAD-CORE-UNIT-01] leaves the old view current when selected native import fails', async () => {
    await withReload(async ({ ledger, reload, lease, replacementLease, integration }) => {
      integration.nativeHistoryImport.load = async function* load() {
        yield [{ message: new UserMessage(TS, 'partial native history') }];
        throw new Error('native iteration failed');
      };

      await expect(reload.reload('chat-1')).rejects.toThrow('native iteration failed');
      expect(ledger.currentView('chat-1')?.viewId).toBe('view-1');
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
        'old current prompt',
        'old current answer',
      ]);
      expect(lease.closed).toBe(true);
      expect(replacementLease.current?.closed).toBe(false);

      replacementLease.current.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'output after failed reload') }],
      });
      expect(ledger.currentView('chat-1')?.viewId).toBe('view-1');
      expect(ledger.conversationMessages('chat-1').at(-1)?.content)
        .toBe('output after failed reload');
    });
  });

  it('preserves the current view while native history is absent and imports only what each retry can read', async () => {
    await withReload(async ({ ledger, reload, integration, oldViewId }) => {
      const command = [
        '<garcon-send-message to="1787974832309199" hide-sender="false">',
        'message body',
        '</garcon-send-message>',
      ].join('\n');
      let attempt = 0;
      integration.nativeHistoryImport.load = async function* load() {
        attempt += 1;
        if (attempt === 1) {
          throw Object.assign(new Error('native history is not present yet'), { code: 'ENOENT' });
        }
        yield [{ message: new UserMessage(TS, 'native prompt') }];
        if (attempt === 3) {
          yield [{ message: new AssistantMessage(TS, command) }];
        }
      };

      await expect(reload.reload('chat-1')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(ledger.currentView('chat-1')?.viewId).toBe(oldViewId);

      await reload.reload('chat-1');
      expect(ledger.currentView('chat-1')?.viewId).not.toBe(oldViewId);
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
        'native prompt',
      ]);
      expect(ledger.currentRows('chat-1').filter(
        (row) => row.kind === 'notice' && row.detail.type === 'inter-agent-send-request',
      )).toEqual([]);

      await reload.reload('chat-1');
      expect(ledger.currentRows('chat-1').filter(
        (row) => row.kind === 'notice' && row.detail.type === 'inter-agent-send-request',
      )).toEqual([
        expect.objectContaining({
          detail: {
            type: 'inter-agent-send-request',
            recipients: ['1787974832309199'],
            hideSender: false,
            body: 'message body',
          },
        }),
      ]);
    });
  });

  it('[TLV5-ADOPT.08-RELOAD-CORE-UNIT-02] cuts over when the selected native session is validly empty', async () => {
    await withReload(async ({ ledger, reload, integration, oldViewId }) => {
      integration.nativeHistoryImport.load = async function* load() {
        yield [];
      };

      const replacement = await reload.reload('chat-1');

      expect(replacement.viewId).not.toBe(oldViewId);
      expect(replacement.contentStartOrdinal).toBe(3);
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
      ]);
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
      ]);
      expect(() => ledger.rowsAfter('chat-1', oldViewId, 0)).toThrow();
    });
  });

  it('[TLV5-L11.05-RELOAD-CORE-UNIT-01] reconciles an ambiguously committed cutover', async () => {
    await withReload(async ({ ledger, reload, lease, replacementLease, oldViewId }) => {
      const events = [];
      ledger.subscribe((event) => events.push(event));
      const injection = injectCutoverCommitFailure('after');
      let replacement;
      try {
        replacement = await reload.reload('chat-1');
      } finally {
        injection.restore();
      }
      await Promise.resolve();

      expect(injection.triggered).toBe(true);
      expect(replacement.viewId).not.toBe(oldViewId);
      expect(ledger.currentView('chat-1')?.viewId).toBe(replacement.viewId);
      expect(events.filter((event) => event.type === 'view-replaced')).toEqual([{
        type: 'view-replaced',
        chatId: 'chat-1',
        previousViewId: oldViewId,
        view: replacement,
      }]);
      expect(lease.closed).toBe(true);
      expect(replacementLease.current?.closed).toBe(false);
      expect(() => replacementLease.current.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'must stay fenced') }],
      })).toThrow(LedgerFencedError);
    });
  });

  it('reopens the old-view producer when cutover rolls back', async () => {
    await withReload(async ({ ledger, reload, lease, replacementLease, oldViewId }) => {
      const events = [];
      ledger.subscribe((event) => events.push(event));
      const injection = injectCutoverCommitFailure('before');
      try {
        await expect(reload.reload('chat-1')).rejects.toThrow(LedgerFencedError);
      } finally {
        injection.restore();
      }
      await Promise.resolve();

      expect(injection.triggered).toBe(true);
      expect(ledger.currentView('chat-1')?.viewId).toBe(oldViewId);
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
        'old current prompt',
        'old current answer',
      ]);
      expect(events.filter((event) => event.type === 'view-replaced')).toEqual([]);
      expect(lease.closed).toBe(true);
      expect(replacementLease.current?.closed).toBe(false);
      expect(() => replacementLease.current.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'must stay fenced') }],
      })).toThrow(LedgerFencedError);
    });
  });

  it('fails before cutover when the staging ordinal cannot be read', async () => {
    await withReload(async ({ ledger, reload, root, oldViewId }) => {
      const events = [];
      ledger.subscribe((event) => events.push(event));
      const query = Database.prototype.query;
      let ordinalReadFailed = false;
      Database.prototype.query = function (sql) {
        if (!ordinalReadFailed && sql.includes('SELECT max(ordinal) AS maximum')) {
          ordinalReadFailed = true;
          throw new Error('injected staging ordinal query failure');
        }
        return query.call(this, sql);
      };
      try {
        await expect(reload.reload('chat-1')).rejects.toThrow(LedgerFencedError);
      } finally {
        Database.prototype.query = query;
      }
      await Promise.resolve();

      expect(ordinalReadFailed).toBe(true);
      expect(() => ledger.currentView('chat-1')).toThrow(LedgerFencedError);
      expect(events.filter((event) => event.type === 'view-replaced')).toEqual([]);
      const db = new Database(path.join(root, 'chat-1', 'ledger.sqlite'), {
        readonly: true,
        create: false,
      });
      expect(db.query("SELECT view_id FROM transcript_views WHERE status = 'current'").get())
        .toEqual({ view_id: oldViewId });
      db.close();
    });
  });

  it('collects an imported history tail that ends with an unanswered user row', async () => {
    await withReload(async ({ ledger, reload, integration }) => {
      integration.nativeHistoryImport.load = async function* load() {
        yield [{ message: new UserMessage(TS, 'native unanswered prompt') }];
      };

      await reload.reload('chat-1');

      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
        'native unanswered prompt',
      ]);
      expect(ledger.resendCandidates('chat-1')).toEqual([{
        ordinal: 4,
        content: 'native unanswered prompt',
        attachmentNames: [],
      }]);
    });
  });

  it('reloads from a native session fact that arrives after interruption', async () => {
    await withReload(async ({ ledger, reload, lease, integration }) => {
      ledger.beginRun('chat-1', 'run-1');
      ledger.interruptRun('chat-1');
      lease.sink.publish({
        type: 'session',
        session: {
          agentSessionId: 'session-late',
          nativeSession: {
            ownerId: 'test',
            schemaVersion: 1,
            value: { id: 'native-late' },
          },
          nativeSeedReceipt: null,
        },
      });
      let importedChat = null;
      integration.nativeHistoryImport.load = async function* load({ chat }) {
        importedChat = chat;
        yield [];
      };

      const replacement = await reload.reload('chat-1');

      expect(importedChat).toMatchObject({
        agentSessionId: 'session-late',
        nativeSession: {
          ownerId: 'test',
          value: { id: 'native-late' },
        },
      });
      expect(replacement.contentStartOrdinal).toBe(3);
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
      ]);
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-late');
    });
  });

  it('reconstructs preamble notices while keeping bodies out of the replacement view', async () => {
    await withReload(async ({ ledger, reload, integration }) => {
      const boundary = { kind: 'new-chat', ownershipEpoch: 'ownership-1' };
      const application = ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: ledger.currentView('chat-1').viewId,
        message: new UserMessage(TS, 'visible boundary prompt'),
        attachments: [],
        clientMessageId: 'preamble-boundary-input',
        steer: false,
        preambleBoundary: boundary,
        preambles: [{
          id: 'preamble-1',
          enabled: true,
          title: 'Repository rules',
          content: 'private preamble body',
          scope: { type: 'global' },
          createdAt: TS,
          updatedAt: TS,
        }],
      });
      integration.nativeHistoryImport.load = async function* load() {
        yield [{
          message: new UserMessage(TS, `${application.providerPrefix}visible boundary prompt`),
        }];
      };

      await reload.reload('chat-1');

      const rows = ledger.currentRows('chat-1');
      expect(rows.slice(-2)).toMatchObject([
        {
          kind: 'notice',
          message: 'Preambles applied',
          detail: {
            type: 'preamble-application',
            preambles: [{ id: 'preamble-1', title: 'Repository rules' }],
          },
        },
        {
          kind: 'user-input',
          detail: {
            message: { content: 'visible boundary prompt' },
            preambleBoundary: boundary,
          },
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain('private preamble body');
    });
  });

  it('preserves completed preamble evidence until native history persists the turn', async () => {
    await withReload(async ({ ledger, reload, integration, lease, oldViewId }) => {
      const boundary = { kind: 'new-chat', ownershipEpoch: 'ownership-1' };
      const application = ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: oldViewId,
        message: new UserMessage(TS, 'visible boundary prompt'),
        attachments: [],
        clientMessageId: 'completed-preamble-input',
        steer: false,
        preambleBoundary: boundary,
        preambles: [{
          id: 'preamble-1',
          enabled: true,
          title: 'Repository rules',
          content: 'private preamble body',
          scope: { type: 'global' },
          createdAt: TS,
          updatedAt: TS,
        }],
      });
      ledger.beginRun('chat-1', 'completed-preamble-run');
      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'completed live answer') }],
      });
      lease.sink.publish({
        type: 'run-ended',
        runId: 'completed-preamble-run',
        outcome: 'finished',
      });
      let importAttempt = 0;
      integration.nativeHistoryImport.load = async function* load() {
        importAttempt += 1;
        yield [
          { message: new UserMessage(TS, 'native prompt') },
          { message: new AssistantMessage(TS, 'native answer') },
          ...(importAttempt === 1
            ? []
            : [
                {
                  message: new UserMessage(
                    TS,
                    `${application.providerPrefix}visible boundary prompt`,
                  ),
                },
                { message: new AssistantMessage(TS, 'completed native answer') },
              ]),
        ];
      };

      await expect(reload.reload('chat-1')).rejects.toMatchObject({
        code: 'HISTORY_LOAD_FAILED',
        retryable: true,
      });
      expect(ledger.currentView('chat-1').viewId).toBe(oldViewId);
      expect(ledger.currentRows('chat-1')).toContainEqual(expect.objectContaining({
        kind: 'user-input',
        detail: expect.objectContaining({
          clientMessageId: 'completed-preamble-input',
          preamblePrefixReceipt: application.input.detail.preamblePrefixReceipt,
        }),
      }));

      await reload.reload('chat-1');
      await reload.reload('chat-1');

      const rows = ledger.currentRows('chat-1');
      const noticeIndex = rows.findIndex(
        (row) => row.kind === 'notice' && row.detail.type === 'preamble-application',
      );
      expect(noticeIndex).toBeGreaterThanOrEqual(0);
      expect(rows.slice(noticeIndex, noticeIndex + 2)).toMatchObject([
        {
          kind: 'notice',
          detail: {
            type: 'preamble-application',
            preambles: [{ id: 'preamble-1', title: 'Repository rules' }],
          },
        },
        {
          kind: 'user-input',
          detail: {
            message: { content: 'visible boundary prompt' },
            preambleBoundary: boundary,
            preamblePrefixReceipt: application.input.detail.preamblePrefixReceipt,
          },
        },
      ]);
      expect(importAttempt).toBe(3);
      expect(JSON.stringify(rows)).not.toContain('private preamble body');
    });
  });

  it('preserves receipt evidence across repeated reloads of control-shaped boundary inputs', async () => {
    const visiblePrompts = [
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      '<garcon-message from="1787974832309199">\nmessage body\n</garcon-message>',
    ];
    for (const visiblePrompt of visiblePrompts) {
      await withReload(async ({ ledger, reload, integration }) => {
        const boundary = { kind: 'new-chat', ownershipEpoch: 'ownership-1' };
        const application = ledger.appendInputAndCompose({
          chatId: 'chat-1',
          viewId: ledger.currentView('chat-1').viewId,
          message: new UserMessage(TS, visiblePrompt),
          attachments: [],
          clientMessageId: 'control-shaped-boundary-input',
          steer: false,
          preambleBoundary: boundary,
          preambles: [{
            id: 'preamble-1',
            enabled: true,
            title: 'Repository rules',
            content: 'private preamble body',
            scope: { type: 'global' },
            createdAt: TS,
            updatedAt: TS,
          }],
        });
        integration.nativeHistoryImport.load = async function* load() {
          yield [{ message: new UserMessage(TS, `${application.providerPrefix}${visiblePrompt}`) }];
        };

        await reload.reload('chat-1');
        await reload.reload('chat-1');

        const rows = ledger.currentRows('chat-1');
        expect(rows.slice(-2)).toMatchObject([
          { kind: 'notice', detail: { type: 'preamble-application' } },
          {
            kind: 'user-input',
            detail: {
              message: { content: visiblePrompt },
              preambleBoundary: boundary,
              preamblePrefixReceipt: application.input.detail.preamblePrefixReceipt,
            },
          },
        ]);
        expect(JSON.stringify(rows)).not.toContain('private preamble body');
      });
    }
  });

  it('allows a committed preamble application absent from native history after a pre-dispatch crash', async () => {
    await withReload(async ({ ledger, reload, oldViewId }) => {
      ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: oldViewId,
        message: new UserMessage(TS, 'visible boundary prompt'),
        attachments: [],
        clientMessageId: 'preamble-missing-input',
        steer: false,
        preambleBoundary: { kind: 'new-chat', ownershipEpoch: 'ownership-1' },
        preambles: [{
          id: 'preamble-1',
          enabled: true,
          title: 'Repository rules',
          content: 'private preamble body',
          scope: { type: 'global' },
          createdAt: TS,
          updatedAt: TS,
        }],
      });

      await reload.reload('chat-1');

      expect(ledger.currentView('chat-1').viewId).not.toBe(oldViewId);
      const rows = ledger.currentRows('chat-1');
      expect(rows.map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
        'user-input',
        'provider-row',
      ]);
      expect(rows).not.toContainEqual(expect.objectContaining({
        kind: 'notice',
        detail: expect.objectContaining({ type: 'preamble-application' }),
      }));
      expect(JSON.stringify(rows)).not.toContain('private preamble body');
      expect(JSON.stringify(rows)).not.toContain('visible boundary prompt');
    });
  });

  it('durably clears a stale zero-match boundary proof before native cutover', async () => {
    await withReload(async ({ ledger, reload, entry, integration, registryUpdates }) => {
      const boundary = { kind: 'fork', ownershipEpoch: 'ownership-1' };
      ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: ledger.currentView('chat-1').viewId,
        message: new UserMessage(TS, 'zero-match boundary prompt'),
        attachments: [],
        clientMessageId: 'preamble-zero-match-input',
        steer: false,
        preambleBoundary: boundary,
        preambles: [],
      });
      entry.pendingPreambleBoundary = boundary;
      integration.nativeHistoryImport.load = async function* load() {
        expect(entry.pendingPreambleBoundary).toBeNull();
        yield [{ message: new UserMessage(TS, 'native prompt') }];
      };

      await reload.reload('chat-1');

      expect(registryUpdates).toContainEqual({
        patch: { pendingPreambleBoundary: null },
        options: undefined,
      });
      expect(entry.pendingPreambleBoundary).toBeNull();
    });
  });

  it('flushes an already-cleared boundary state before native cutover', async () => {
    const flushStarted = deferred();
    const allowFlush = deferred();
    const importStarted = deferred();
    await withReload(async ({ reload, integration }) => {
      integration.nativeHistoryImport.load = async function* load() {
        importStarted.resolve();
        yield [{ message: new UserMessage(TS, 'native prompt') }];
      };

      const reloading = reload.reload('chat-1');
      await flushStarted.promise;
      let imported = false;
      void importStarted.promise.then(() => { imported = true; });
      await Promise.resolve();
      expect(imported).toBe(false);

      allowFlush.resolve();
      await reloading;
      expect(imported).toBe(true);
    }, {
      flushRegistry: async () => {
        flushStarted.resolve();
        await allowFlush.promise;
      },
    });
  });

  it('[TLV5-ADOPT.06-CORE-UNIT-01] carries the quarantine notice through reload while dropping ordinary notices', async () => {
    const quarantineDetail = {
      type: 'carryover-migration-quarantine',
      artifactId: 'artifact-1',
      errorCode: 'CARRYOVER_PARSE_FAILED',
    };
    await withReload(async ({ ledger, reload }) => {
      const replacement = await reload.reload('chat-1');
      const notices = ledger.currentRows('chat-1').filter((row) => row.kind === 'notice');

      expect(replacement.contentStartOrdinal).toBe(4);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        message: 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
        detail: quarantineDetail,
      });
    }, {
      frozenDrafts: [
        {
          kind: 'notice',
          at: TS,
          providerMeta: null,
          message: 'Ordinary durable notice.',
          detail: { type: 'ordinary-notice' },
        },
        {
          kind: 'notice',
          at: TS,
          providerMeta: null,
          message: 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
          detail: quarantineDetail,
        },
      ],
    });
  });

  it('drops chat rows and provider errors from frozen and current bindings during native reload', async () => {
    await withReload(async ({ ledger, reload, lease }) => {
      const currentView = ledger.currentView('chat-1');
      ledger.appendChatRow({
        chatId: 'chat-1',
        viewId: currentView.viewId,
        clientMessageId: 'current-notice',
        presentation: { style: 'notice' },
        format: 'plain',
        content: 'current notice',
      });
      ledger.appendChatRow({
        chatId: 'chat-1',
        viewId: currentView.viewId,
        clientMessageId: 'current-error',
        presentation: { style: 'error' },
        format: 'plain',
        content: 'current error',
      });
      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new ErrorMessage(TS, 'current provider error') }],
      });

      const replacement = await reload.reload('chat-1');
      const rows = ledger.currentRows('chat-1');

      expect(replacement.contentStartOrdinal).toBe(3);
      expect(rows.some((row) => row.kind === 'notice' && row.detail.type === 'cli-row')).toBe(false);
      expect(JSON.stringify(rows)).not.toContain('frozen notice');
      expect(JSON.stringify(rows)).not.toContain('frozen error');
      expect(JSON.stringify(rows)).not.toContain('frozen provider error');
      expect(JSON.stringify(rows)).not.toContain('current notice');
      expect(JSON.stringify(rows)).not.toContain('current error');
      expect(JSON.stringify(rows)).not.toContain('current provider error');
    }, {
      frozenDrafts: [
        {
          kind: 'notice',
          at: TS,
          providerMeta: null,
          message: 'frozen notice',
          detail: {
            type: 'cli-row',
            clientMessageId: 'frozen-notice',
            presentation: { style: 'notice' },
            format: 'plain',
            disclosure: 'expanded',
            title: null,
          },
        },
        {
          kind: 'notice',
          at: TS,
          providerMeta: null,
          message: 'frozen error',
          detail: {
            type: 'cli-row',
            clientMessageId: 'frozen-error',
            presentation: { style: 'error' },
            format: 'plain',
            disclosure: 'expanded',
            title: null,
          },
        },
        {
          kind: 'provider-row',
          at: TS,
          providerMeta: null,
          message: new ErrorMessage(TS, 'frozen provider error'),
        },
      ],
    });
  });

  it('[TLV5-CHAT-ROW.04-RELOAD-INTERLEAVING-CORE-UNIT-01] holds the shared mutation lock through reload cleanup', async () => {
    await withReload(async ({ reload, integration, execution, chatMutationLock }) => {
      const importStarted = deferred();
      const allowImport = deferred();
      const releaseStarted = deferred();
      const allowRelease = deferred();
      integration.nativeHistoryImport.load = async function* () {
        importStarted.resolve();
        await allowImport.promise;
        yield [];
      };
      execution.releaseTranscriptSnapshot = async () => {
        releaseStarted.resolve();
        await allowRelease.promise;
      };

      const reloading = reload.reload('chat-1');
      await importStarted.promise;
      let admitted = false;
      const competing = chatMutationLock.runExclusive('chat:chat-1', async () => {
        admitted = true;
      });
      await Promise.resolve();
      expect(admitted).toBe(false);

      allowImport.resolve();
      await releaseStarted.promise;
      await Promise.resolve();
      expect(admitted).toBe(false);

      allowRelease.resolve();
      await reloading;
      await competing;
      expect(admitted).toBe(true);
    });
  });
});

async function withReload(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-reload-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => 'view-1',
    now: () => TS,
  });
  const ledger = new TranscriptLedgerService(store, { now: () => TS });
  const frozenDrafts = options.frozenDrafts ?? [];
  const old = ledger.initializeChat('chat-1', [
    inputDraft('frozen prompt', 'frozen-1'),
    providerDraft('frozen answer'),
    ...frozenDrafts,
    {
      kind: 'session',
      at: TS,
      detail: {
        agentSessionId: 'session-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
        nativeSeedReceipt: null,
      },
      providerMeta: null,
    },
    inputDraft('old current prompt', 'old-1'),
    providerDraft('old current answer'),
    { kind: 'run-ended', at: TS, outcome: 'finished', origin: 'provider', providerMeta: null },
  ], 3 + frozenDrafts.length);
  const lease = ledger.openProducer('chat-1', 'test');
  const entry = {
    agentId: 'test',
    agentOwnershipEpoch: 'ownership-1',
    agentSessionId: 'stale-cache',
    nativeSession: null,
    nativeSeedReceipt: null,
    projectPath: '/tmp',
    model: 'model',
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
    carryOverSegments: [],
    carryOverMigrationQuarantine: null,
  };
  const integration = {
    descriptor: { id: 'test' },
    settings: { parse: (value) => value },
    nativeHistoryImport: {
      async *load() {
        yield [
          {
            message: new UserMessage(
              TS,
              'native prompt',
              undefined,
              { upstreamRequestId: 'native-message' },
            ),
          },
          { message: new AssistantMessage(TS, 'native answer') },
        ];
      },
    },
  };
  const execution = {
    queueEntries: [],
    reserveTranscriptSnapshot: (chatId) => ({ chatId, reservationId: 'reservation-1' }),
    releaseTranscriptSnapshot: async () => undefined,
    async readChatExecutionControl() {
      return { entries: this.queueEntries, controlEntries: [] };
    },
  };
  const registryUpdates = [];
  const registry = {
    getChat: () => entry,
    updateChat: (_chatId, patch, updateOptions) => {
      registryUpdates.push({ patch, options: updateOptions });
      return Object.assign(entry, patch);
    },
    flush: async () => options.flushRegistry?.(),
  };
  const integrations = {
    get: () => integration,
    require: () => integration,
  };
  const adoption = new TranscriptAdoptionService({
    ledger,
    registry,
    integrations,
    getCarryOverRevision: () => 'carry-v1:0',
    loadFrozenPrefix: async () => [],
    loadLegacyCurrent: async () => [],
  });
  const replacementLease = { current: null };
  const chatMutationLock = new KeyedPromiseLock();
  const reload = new TranscriptReloadService({
    ledger,
    adoption,
    registry,
    integrations,
    execution,
    reopenProducer: () => {
      replacementLease.current = ledger.openProducer('chat-1', 'test');
    },
    getCarryOverRevision: () => 'carry-v1:0',
    chatMutationLock,
    now: () => TS,
  });
  try {
    await run({
      root,
      ledger,
      reload,
      lease,
      replacementLease,
      execution,
      integration,
      entry,
      registryUpdates,
      oldViewId: old.viewId,
      chatMutationLock,
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function injectCutoverCommitFailure(when) {
  const query = Database.prototype.query;
  const exec = Database.prototype.exec;
  let cutoverStarted = false;
  let triggered = false;
  Database.prototype.query = function (sql) {
    if (sql.includes("UPDATE transcript_views SET status = 'current'")) {
      cutoverStarted = true;
    }
    return query.call(this, sql);
  };
  Database.prototype.exec = function (sql) {
    if (cutoverStarted && !triggered && sql === 'COMMIT') {
      triggered = true;
      if (when === 'after') exec.call(this, sql);
      throw new Error(`injected ${when}-commit cutover failure`);
    }
    return exec.call(this, sql);
  };
  return {
    get triggered() { return triggered; },
    restore() {
      Database.prototype.query = query;
      Database.prototype.exec = exec;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

function inputDraft(content, clientMessageId) {
  return {
    kind: 'user-input',
    at: TS,
    detail: {
      clientMessageId,
      message: new UserMessage(TS, content),
      attachments: [],
      steer: false,
    },
    providerMeta: null,
  };
}

function providerDraft(content) {
  return {
    kind: 'provider-row',
    at: TS,
    message: new AssistantMessage(TS, content),
    providerMeta: null,
  };
}
