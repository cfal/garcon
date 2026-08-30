import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantMessage,
  BashToolUseMessage,
  ToolResultMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import { transcriptViewId } from '../contracts.ts';
import { LedgerFencedError, PermissionNotActionableError } from '../errors.ts';
import { TranscriptLedgerService, TranscriptSinkClosedError } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('TranscriptLedgerService', () => {
  describe('chat ID discovery requests', () => {
    it('[TLV5-CHAT-ID-DISCOVERY.01-CORE-UNIT-01] commits and strips the marker before starting immediate delivery', async () => {
      const requests = mock(() => undefined);
      await withService(async ({ ledger }) => {
        ledger.initializeChat('chat-1');
        const lease = ledger.openProducer('chat-1', 'test');
        ledger.beginRun('chat-1', 'run-1');
        const notifications = [];
        ledger.subscribe((event) => notifications.push(event));
        requests.mockImplementation((input) => {
          expect(ledger.currentRows('chat-1')).toHaveLength(2);
          expect(notifications).toEqual([]);
          expect(input).toMatchObject({ chatId: 'chat-1', runId: 'run-1' });
        });

        lease.sink.publish({
          type: 'rows',
          rows: [{
            message: new AssistantMessage(
              TS,
              '<garcon-get-chat-id />\nContinuing the response.',
            ),
          }],
        });

        expect(requests).toHaveBeenCalledTimes(1);
        expect(ledger.currentRows('chat-1')).toMatchObject([
          {
            kind: 'provider-row',
            message: { type: 'assistant-message', content: 'Continuing the response.' },
          },
          {
            kind: 'notice',
            at: TS,
            message: 'Agent requested chat ID',
            detail: { type: 'chat-id-request' },
          },
        ]);
        await tick();
        expect(notifications).toHaveLength(1);
      }, {
        chatIdRequests: { request: requests },
      });
    });

    it('commits a hidden row before dispatching a marker-only request', async () => {
      const requests = mock(() => undefined);
      await withService(async ({ ledger }) => {
        ledger.initializeChat('chat-1');
        const lease = ledger.openProducer('chat-1', 'test');

        lease.sink.publish({
          type: 'rows',
          rows: [{ message: new AssistantMessage(TS, '<garcon-get-chat-id />') }],
        });

        expect(requests).toHaveBeenCalledWith({
          chatId: 'chat-1',
          viewId: expect.any(String),
          runId: null,
          at: TS,
        });
        expect(ledger.currentRows('chat-1')).toMatchObject([{
          ordinal: 1,
          kind: 'notice',
          at: TS,
          message: 'Agent requested chat ID',
          detail: { type: 'chat-id-request' },
          providerMeta: null,
        }]);
        expect(ledger.conversationMessages('chat-1')).toEqual([]);
      }, {
        chatIdRequests: { request: requests },
      });
    });
  });

  describe('Garcon command publication', () => {
    it('commits cleaned output and private command evidence before ordered dispatch', async () => {
      const dispatches = [];
      const chatIdRequests = mock((input) => dispatches.push({ type: 'get-chat-id', input }));
      const interAgentMessages = mock((input) => {
        dispatches.push({ type: 'send-message', input });
      });
      await withService(async ({ ledger }) => {
        ledger.initializeChat('chat-1');
        const lease = ledger.openProducer('chat-1', 'test');
        ledger.beginRun('chat-1', 'run-1');
        const notifications = [];
        ledger.subscribe((event) => notifications.push(event));
        interAgentMessages.mockImplementation((input) => {
          expect(ledger.currentRows('chat-1')).toHaveLength(3);
          expect(notifications).toEqual([]);
          dispatches.push({ type: 'send-message', input });
        });

        lease.sink.publish({
          type: 'rows',
          rows: [{
            message: new AssistantMessage(
              TS,
              '<garcon-get-chat-id />\n'
                + '<garcon-send-message to="1787974832309199, 1787973671383699" hide-sender="true">\n'
                + 'message body\n'
                + '</garcon-send-message>\n'
                + 'Continuing the response.',
            ),
          }],
        });

        expect(dispatches).toEqual([
          {
            type: 'get-chat-id',
            input: {
              chatId: 'chat-1',
              viewId: expect.any(String),
              runId: 'run-1',
              at: TS,
            },
          },
          {
            type: 'send-message',
            input: {
              sourceChatId: 'chat-1',
              sourceViewId: expect.any(String),
              requestAt: TS,
              recipients: ['1787974832309199', '1787973671383699'],
              hideSender: true,
              body: 'message body',
            },
          },
        ]);
        expect(ledger.currentRows('chat-1')).toMatchObject([
          {
            ordinal: 1,
            kind: 'provider-row',
            message: { type: 'assistant-message', content: 'Continuing the response.' },
          },
          { ordinal: 2, kind: 'notice', detail: { type: 'chat-id-request' } },
          {
            ordinal: 3,
            kind: 'notice',
            detail: {
              type: 'inter-agent-send-request',
              recipients: ['1787974832309199', '1787973671383699'],
              hideSender: true,
              body: 'message body',
            },
          },
        ]);
        await tick();
        expect(notifications).toHaveLength(1);
      }, {
        chatIdRequests: { request: chatIdRequests },
        interAgentMessages: { request: interAgentMessages },
      });
    });

    it('keeps malformed commands as provider output and appends a visible diagnostic', async () => {
      const requests = mock(() => undefined);
      await withService(async ({ ledger }) => {
        ledger.initializeChat('chat-1');
        const lease = ledger.openProducer('chat-1', 'test');
        const content = '<garcon-send-message to="invalid" hide-sender="false">body</garcon-send-message>';

        lease.sink.publish({
          type: 'rows',
          rows: [{ message: new AssistantMessage(TS, content) }],
        });

        expect(requests).not.toHaveBeenCalled();
        expect(ledger.currentRows('chat-1')).toMatchObject([
          {
            kind: 'provider-row',
            message: { type: 'assistant-message', content },
          },
          {
            kind: 'notice',
            at: TS,
            message: 'Garcon could not parse an inter-agent message command.',
            detail: { title: 'Inter-agent message' },
          },
        ]);
      }, { interAgentMessages: { request: requests } });
    });
  });

  it('[TLV5-L03.01-CORE-UNIT-01] commits producer events synchronously and notifies after publish returns', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      const notifications = [];
      ledger.subscribe((event) => notifications.push(event));

      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'answer') }],
      });

      expect(ledger.currentRows('chat-1')).toHaveLength(1);
      expect(notifications).toEqual([]);
      await tick();
      expect(notifications).toHaveLength(1);
    });
  });

  it('decides publish and close by synchronous call order', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');

      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'accepted before close') }],
      });
      lease.close();

      expect(ledger.conversationMessages('chat-1').map((message) => message.content))
        .toEqual(['accepted before close']);
      expect(() => lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'rejected after close') }],
      })).toThrow(TranscriptSinkClosedError);
      expect(ledger.conversationMessages('chat-1').map((message) => message.content))
        .toEqual(['accepted before close']);
    });
  });

  it('notifies once for a fresh chat row and not for its exact retry', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      const notifications = [];
      ledger.subscribe((event) => notifications.push(event));

      const first = ledger.appendChatRow({
        chatId: 'chat-1',
        viewId: view.viewId,
        clientMessageId: 'chat-row-1',
        presentation: { style: 'error' },
        format: 'plain',
        title: 'Release validation',
        content: 'durable error',
      });
      const retry = ledger.appendChatRow({
        chatId: 'chat-1',
        viewId: view.viewId,
        clientMessageId: 'chat-row-1',
        presentation: { style: 'error' },
        format: 'plain',
        title: 'Release validation',
        content: 'durable error',
      });

      expect(first.inserted).toBe(true);
      expect(retry.inserted).toBe(false);
      expect(notifications).toEqual([]);
      await tick();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        type: 'rows',
        rows: [{
          kind: 'notice',
          message: 'durable error',
          detail: {
            type: 'cli-row',
            presentation: { style: 'error' },
            format: 'plain',
            disclosure: 'expanded',
            title: 'Release validation',
          },
        }],
      });
      expect(ledger.conversationMessages('chat-1')).toEqual([]);
    });
  });

  it('commits and notifies one validated internal notice', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      const notifications = [];
      ledger.subscribe((event) => notifications.push(event));

      const row = ledger.appendNotice('chat-1', view.viewId, {
        title: 'Handoff summary',
        content: 'Objective\n\n  Preserve formatting.',
      });

      expect(row).toMatchObject({
        kind: 'notice',
        at: TS,
        message: 'Objective\n\n  Preserve formatting.',
        detail: { title: 'Handoff summary' },
        providerMeta: null,
      });
      expect(ledger.currentRows('chat-1')).toEqual([row]);
      expect(ledger.conversationMessages('chat-1')).toEqual([]);
      expect(notifications).toEqual([]);
      await tick();
      expect(notifications).toEqual([expect.objectContaining({
        type: 'rows',
        chatId: 'chat-1',
        viewId: view.viewId,
        rows: [row],
      })]);
    });
  });

  it('preserves typed detail on an internal notice', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      expect(ledger.appendNotice('chat-1', view.viewId, {
        title: 'Response: Garcon Chat ID',
        content: 'Sent chat ID 1787836573296800 to agent',
        detail: { type: 'chat-id-disclosure' },
      })).toMatchObject({
        kind: 'notice',
        detail: {
          type: 'chat-id-disclosure',
          title: 'Response: Garcon Chat ID',
        },
      });
    });
  });

  it('deduplicates only identical carryover notices in the current binding', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      const summary = {
        title: 'Handoff summary',
        content: 'Original summary',
        detail: { type: 'handoff-summary' },
      };

      const first = ledger.appendCarryoverNotice('chat-1', view.viewId, summary);
      expect(ledger.appendCarryoverNotice('chat-1', view.viewId, summary)).toEqual(first);
      const changed = ledger.appendCarryoverNotice('chat-1', view.viewId, {
        ...summary,
        content: 'Updated summary',
      });

      expect(changed.ordinal).toBe(first.ordinal + 1);
      ledger.advanceContentStart('chat-1', view.viewId, changed.ordinal + 1);
      const nextBinding = ledger.appendCarryoverNotice('chat-1', view.viewId, summary);
      expect(nextBinding.ordinal).toBe(changed.ordinal + 1);
      expect(ledger.currentRows('chat-1')).toEqual([first, changed, nextBinding]);
    });
  });

  it('rejects an invalid internal notice before append', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');

      expect(() => ledger.appendNotice('chat-1', view.viewId, {
        title: 'two\nlines',
        content: 'valid',
      })).toThrow('single line');
      expect(() => ledger.appendNotice('chat-1', view.viewId, {
        title: 'Handoff summary',
        content: '  \n\t',
      })).toThrow('content is required');
      expect(() => ledger.appendNotice('chat-1', view.viewId, {
        title: 'Handoff summary',
        content: String.fromCharCode(0xd800),
      })).toThrow('well-formed Unicode');
      expect(() => ledger.appendNotice('chat-1', view.viewId, {
        title: 'Handoff summary',
        content: 'x'.repeat(65_537),
      })).toThrow('65536 UTF-8 bytes');
      expect(() => ledger.appendNotice('chat-1', transcriptViewId('stale-view'), {
        title: 'Handoff summary',
        content: 'valid',
      })).toThrow();
      expect(ledger.currentRows('chat-1')).toEqual([]);
    });
  });

  it('fences an ambiguous commit without broadcasting it', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('failed-chat');
      ledger.initializeChat('healthy-chat');
      const failed = ledger.openProducer('failed-chat', 'test');
      const healthy = ledger.openProducer('healthy-chat', 'test');
      const notifications = [];
      ledger.subscribe((event) => notifications.push(event));
      const exec = Database.prototype.exec;
      let commitBecameAmbiguous = false;
      Database.prototype.exec = function (sql) {
        const result = exec.call(this, sql);
        if (!commitBecameAmbiguous && sql === 'COMMIT') {
          commitBecameAmbiguous = true;
          throw new Error('injected unknown transcript commit outcome');
        }
        return result;
      };
      try {
        expect(() => failed.sink.publish({
          type: 'rows',
          rows: [{ message: new AssistantMessage(TS, 'ambiguous answer') }],
        })).toThrow(LedgerFencedError);
      } finally {
        Database.prototype.exec = exec;
      }

      expect(commitBecameAmbiguous).toBe(true);
      expect(() => ledger.currentRows('failed-chat')).toThrow(LedgerFencedError);
      await tick();
      expect(notifications).toEqual([]);

      healthy.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'healthy answer') }],
      });
      await tick();
      expect(notifications).toHaveLength(1);
      expect(ledger.currentRows('healthy-chat')[0]).toMatchObject({
        kind: 'provider-row',
        message: { content: 'healthy answer' },
      });
    });
  });

  it('snapshots producer payloads at synchronous acceptance', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      const notifications = [];
      ledger.subscribe((event) => notifications.push(event));
      const message = new ToolResultMessage(
        TS,
        'tool-1',
        { raw: 'accepted tool output' },
        false,
      );
      const providerMeta = { nativeIdentity: { itemId: 'accepted-item' } };

      lease.sink.publish({
        type: 'rows',
        rows: [{ message, providerMeta }],
      });
      message.content.raw = 'mutated after publish';
      providerMeta.nativeIdentity.itemId = 'mutated-after-publish';
      await tick();

      const row = ledger.currentRows('chat-1')[0];
      expect(row).toMatchObject({
        kind: 'provider-row',
        message: {
          type: 'tool-result',
          content: { raw: 'accepted tool output' },
        },
        providerMeta: { nativeIdentity: { itemId: 'accepted-item' } },
      });
      expect(row.message).not.toBe(message);
      expect(row.providerMeta).not.toBe(providerMeta);
      expect(notifications).toMatchObject([{
        type: 'rows',
        rows: [{
          message: { content: { raw: 'accepted tool output' } },
          providerMeta: { nativeIdentity: { itemId: 'accepted-item' } },
        }],
      }]);
    });
  });

  it('rejects malformed producer rows before they reach SQLite', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');

      expect(() => lease.sink.publish({
        type: 'rows',
        rows: [{ message: { type: 'assistant-message', timestamp: '', content: 'invalid' } }],
      })).toThrow('row timestamp must be a non-empty string');
      expect(ledger.currentRows('chat-1')).toEqual([]);
    });
  });

  it('repairs session execution state before publish returns', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      const sessions = [];
      const notifications = [];
      ledger.subscribeSessionCommitted((event) => sessions.push(event.row.detail.agentSessionId));
      ledger.subscribe((event) => notifications.push(event));

      lease.sink.publish({
        type: 'session',
        session: { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null },
      });

      expect(sessions).toEqual(['session-1']);
      expect(notifications).toEqual([]);
      await tick();
      expect(notifications).toHaveLength(1);
    });
  });

  it('rejects invalid session authority before committing it', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');

      expect(() => lease.sink.publish({
        type: 'session',
        session: {
          agentSessionId: 'session-1',
          nativeSession: { ownerId: 'other', schemaVersion: 1, value: {} },
          nativeSeedReceipt: null,
        },
      })).toThrow('Native session owner mismatch');
      expect(() => lease.sink.publish({
        type: 'session',
        session: {
          agentSessionId: 'session-1',
          nativeSession: null,
          nativeSeedReceipt: {
            agentSessionId: 'session-2',
            placement: 'user-prefix',
            format: 'v3-xml',
            codeUnitLength: 1,
            sha256: 'a'.repeat(64),
          },
        },
      })).toThrow('native seed receipt session mismatch');
      expect(ledger.currentRows('chat-1')).toEqual([]);
    });
  });

  it('reports a cache-listener failure without rejecting an accepted session', async () => {
    const errors = [];
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.subscribeSessionCommitted(() => {
        throw new Error('cache unavailable');
      });

      expect(() => lease.sink.publish({
        type: 'session',
        session: { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null },
      })).not.toThrow();
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-1');
      expect(errors).toHaveLength(1);
    }, { onListenerError: (error) => errors.push(error) });
  });

  it('[TLV5-L07.01-CORE-UNIT-01] uses the sink object as the ownership fence', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const old = ledger.openProducer('chat-1', 'test');
      old.close();
      const current = ledger.openProducer('chat-1', 'test');

      expect(() => old.sink.publish({ type: 'rows', rows: [] }))
        .toThrow(TranscriptSinkClosedError);
      current.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'current') }],
      });
      expect(ledger.conversationMessages('chat-1').map((message) => message.content))
        .toEqual(['current']);
    });
  });

  it('keeps a deleted chat sink fenced when the same chat id is recreated', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const deleted = ledger.openProducer('chat-1', 'test');
      deleted.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'deleted view output') }],
      });

      ledger.deleteChat('chat-1');
      ledger.initializeChat('chat-1');
      const replacement = ledger.openProducer('chat-1', 'test');

      expect(() => deleted.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'stale deleted output') }],
      })).toThrow(TranscriptSinkClosedError);
      replacement.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'replacement output') }],
      });
      expect(ledger.conversationMessages('chat-1').map((message) => message.content))
        .toEqual(['replacement output']);
    });
  });

  it('[TLV5-L05.03-CORE-UNIT-01] commits named late output after an accepted run terminal', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'before terminal') }],
      });
      lease.sink.publish({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });

      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'after terminal') }],
      });
      lease.sink.publish({
        type: 'session',
        session: {
          agentSessionId: 'late-session',
          nativeSession: null,
          nativeSeedReceipt: null,
        },
      });

      expect(ledger.activeRunId('chat-1')).toBeNull();
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'provider-row',
        'run-ended',
        'provider-row',
        'session',
      ]);
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'before terminal',
        'after terminal',
      ]);
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('late-session');
    });
  });

  it('[TLV5-L05.04-CORE-UNIT-01] ignores stale terminals while retaining late content and session facts', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      expect(ledger.interruptRun('chat-1')?.outcome).toBe('interrupted');
      ledger.beginRun('chat-1', 'run-2');

      lease.sink.publish({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });
      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'late') }],
      });
      lease.sink.publish({
        type: 'session',
        session: { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null },
      });

      expect(ledger.activeRunId('chat-1')).toBe('run-2');
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'run-ended',
        'provider-row',
        'session',
      ]);
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-1');
    });
  });

  it('records a core failure once and ignores the later provider end', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');

      ledger.failRun('chat-1', 'run-1', { code: 'PROVIDER_FAILURE', message: 'launch failed' });
      lease.sink.publish({ type: 'run-ended', runId: 'run-1', outcome: 'failed' });

      expect(ledger.currentRows('chat-1')).toMatchObject([{
        kind: 'run-ended',
        origin: 'core',
        error: { code: 'PROVIDER_FAILURE', message: 'launch failed' },
      }]);
    });
  });

  it('keeps permission history durable while actionability follows the active run', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      lease.sink.publish({
        type: 'permission',
        runId: 'run-1',
        lifecycle: permissionRequest('incarnation-1'),
        decision: permissionDecision('incarnation-1'),
      });

      const claim = ledger.claimPermissionResolution(permissionControl());
      const resolved = ledger.completePermissionResolution(claim, { allow: true });

      expect(resolved).toMatchObject({
        kind: 'permission-resolved',
        lifecycle: {
          permissionOccurrenceId: 'incarnation-1',
          decision: { allow: true },
        },
      });
      expect(() => ledger.claimPermissionResolution(permissionControl()))
        .toThrow(PermissionNotActionableError);
    }, { serverInstanceId: 'server-1' });
  });

  it('[TLV5-PERM.04-CORE-UNIT-01] keeps distinct permission occurrences separately actionable', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      const firstDecision = permissionDecision('incarnation-1');
      const secondDecision = permissionDecision('incarnation-2');
      lease.sink.publish({
        type: 'permission',
        runId: 'run-1',
        lifecycle: permissionRequest('incarnation-1'),
        decision: firstDecision,
      });
      lease.sink.publish({
        type: 'permission',
        runId: 'run-1',
        lifecycle: permissionRequest('incarnation-2'),
        decision: secondDecision,
      });

      const first = ledger.claimPermissionResolution(permissionControl({
        permissionOccurrenceId: 'incarnation-1',
      }));
      ledger.completePermissionResolution(first, { allow: false });
      const second = ledger.claimPermissionResolution(permissionControl({
        permissionOccurrenceId: 'incarnation-2',
      }));

      expect(first.permissionOccurrenceId).toBe('incarnation-1');
      expect(first.decision).toBe(firstDecision);
      expect(second.permissionOccurrenceId).toBe('incarnation-2');
      expect(second.decision).toBe(secondDecision);
    }, { serverInstanceId: 'server-1' });
  });

  it('commits late permission facts without making them actionable', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      ledger.interruptRun('chat-1');

      lease.sink.publish({
        type: 'permission',
        runId: 'run-1',
        lifecycle: permissionRequest('incarnation-1'),
        decision: permissionDecision('incarnation-1'),
      });

      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'run-ended',
        'permission-requested',
      ]);
      expect(() => ledger.claimPermissionResolution(permissionControl()))
        .toThrow(PermissionNotActionableError);
    }, { serverInstanceId: 'server-1' });
  });

  it('restores a claimed permission after a failed forward only while its run remains active', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      lease.sink.publish({
        type: 'permission',
        runId: 'run-1',
        lifecycle: permissionRequest('incarnation-1'),
        decision: permissionDecision('incarnation-1'),
      });

      const claim = ledger.claimPermissionResolution(permissionControl());
      ledger.abandonPermissionResolution(claim);

      expect(ledger.claimPermissionResolution(permissionControl())).toMatchObject({
        permissionOccurrenceId: 'incarnation-1',
        runId: 'run-1',
      });
    }, { serverInstanceId: 'server-1' });
  });

  it('commits an input and its resend composition as one synchronous operation', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      const first = ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: view.viewId,
        message: new UserMessage(TS, 'first'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      });
      ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      ledger.interruptRun('chat-1');
      const second = ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: view.viewId,
        message: new UserMessage(TS, 'second'),
        attachments: [],
        clientMessageId: 'message-2',
        steer: false,
      });

      expect(first.prompt.map((row) => row.detail.message.content)).toEqual(['first']);
      expect(second.prompt.map((row) => row.detail.message.content)).toEqual(['first', 'second']);
      expect(ledger.resendCandidates('chat-1')).toEqual([
        { ordinal: 1, content: 'first', attachmentNames: [] },
        { ordinal: 3, content: 'second', attachmentNames: [] },
      ]);
    });
  });

  it('does not retain a prepared composition for a duplicate committed input', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      const input = {
        chatId: 'chat-1',
        viewId: view.viewId,
        message: new UserMessage(TS, 'send once'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      };

      expect(ledger.appendInputAndCompose(input).inserted).toBe(true);
      expect(ledger.takePreparedInput('chat-1', 'message-1')).not.toBeNull();
      expect(ledger.appendInputAndCompose(input).inserted).toBe(false);

      expect(ledger.takePreparedInput('chat-1', 'message-1')).toBeNull();
    });
  });

  it('clears an unconsumed prepared composition when the committed input is retried', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      const input = {
        chatId: 'chat-1',
        viewId: view.viewId,
        message: new UserMessage(TS, 'send once'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      };

      expect(ledger.appendInputAndCompose(input).inserted).toBe(true);
      expect(ledger.appendInputAndCompose(input).inserted).toBe(false);

      expect(ledger.takePreparedInput('chat-1', 'message-1')).toBeNull();
      expect(ledger.currentRows('chat-1').filter((row) => row.kind === 'user-input'))
        .toHaveLength(1);
    });
  });

  it('applies one-composition resend exclusions without changing durable history', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: view.viewId,
        message: new UserMessage(TS, 'first'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      });
      const second = ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: view.viewId,
        message: new UserMessage(TS, 'second'),
        attachments: [],
        clientMessageId: 'message-2',
        steer: false,
        excludedOrdinals: new Set([1]),
      });

      expect(second.prompt.map((row) => row.detail.message.content)).toEqual(['second']);
      expect(ledger.resendCandidates('chat-1').map((row) => row.content)).toEqual([
        'first',
        'second',
      ]);
    });
  });

  it('qualifies reload cutover notifications by both transcript views', async () => {
    await withService(async ({ ledger, store }) => {
      const current = ledger.initializeChat('chat-1');
      const stagingId = transcriptViewId('view-2');
      store.stageView('chat-1', { viewId: stagingId, contentStartOrdinal: 1 });
      const events = [];
      ledger.subscribe((event) => events.push(event));

      const replacement = ledger.replaceCurrentView('chat-1', current.viewId, stagingId);
      await tick();

      expect(events).toEqual([{
        type: 'view-replaced',
        chatId: 'chat-1',
        previousViewId: current.viewId,
        view: replacement,
      }]);
    });
  });

  describe('producer notices', () => {
    it('[TLV5-L06.07-CORE-UNIT-01] accepts only active-run nonblank notices as durable display-only rows', async () => {
      await withService(async ({ ledger }) => {
        ledger.initializeChat('chat-1');
        const lease = ledger.openProducer('chat-1', 'test');
        ledger.beginRun('chat-1', 'run-2');
        const notifications = [];
        ledger.subscribe((event) => notifications.push(event));

        lease.sink.publish({ type: 'notice', runId: 'run-1', content: 'stale run' });
        lease.sink.publish({ type: 'notice', runId: 'run-2', content: '   ' });
        lease.sink.publish({
          type: 'notice',
          runId: 'run-2',
          title: 'Provider retry',
          content: 'Model provider retrying: quota exhausted.',
        });

        const rows = ledger.currentRows('chat-1');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: 'notice',
          message: 'Model provider retrying: quota exhausted.',
          detail: { title: 'Provider retry' },
        });
        expect(rows[0]).not.toHaveProperty('runId');
        expect(ledger.conversationMessages('chat-1')).toEqual([]);
        await tick();
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({ type: 'rows', chatId: 'chat-1' });
      });
    });
  });
});

async function withService(run, serviceOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-service-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId('view-1'),
    now: () => TS,
  });
  const ledger = new TranscriptLedgerService(store, { now: () => TS, ...serviceOptions });
  try {
    await run({ ledger, store });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function permissionRequest(permissionOccurrenceId) {
  return {
    kind: 'requested',
    permissionOccurrenceId,
    requestedTool: new BashToolUseMessage(TS, 'tool-1', 'pwd'),
    options: [],
  };
}

function permissionDecision(permissionOccurrenceId) {
  return {
    permissionOccurrenceId,
    respond: async () => undefined,
  };
}

function permissionControl(overrides = {}) {
  return {
    serverInstanceId: 'server-1',
    chatId: 'chat-1',
    runId: 'run-1',
    permissionOccurrenceId: 'incarnation-1',
    ...overrides,
  };
}

function tick() {
  return new Promise((resolve) => queueMicrotask(resolve));
}
