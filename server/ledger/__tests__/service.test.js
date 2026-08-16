import { describe, expect, it } from 'bun:test';
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

  it('commits named late output after an accepted run terminal', async () => {
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

  it('ignores stale terminals while retaining late content and session facts', async () => {
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
        lifecycle: permissionRequest('permission-1', 'incarnation-1'),
        decision: permissionDecision('permission-1', 'incarnation-1'),
      });

      const claim = ledger.claimPermissionResolution(permissionControl());
      const resolved = ledger.completePermissionResolution(claim, { allow: true });

      expect(resolved).toMatchObject({
        kind: 'permission-resolved',
        lifecycle: {
          requestId: 'permission-1',
          incarnation: 'incarnation-1',
          decision: { allow: true },
        },
      });
      expect(() => ledger.claimPermissionResolution(permissionControl()))
        .toThrow(PermissionNotActionableError);
    }, { serverInstanceId: 'server-1' });
  });

  it('keeps reused permission request ids actionable as separate occurrences', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'run-1');
      const firstDecision = permissionDecision('permission-1', 'incarnation-1');
      const secondDecision = permissionDecision('permission-1', 'incarnation-2');
      lease.sink.publish({
        type: 'permission',
        runId: 'run-1',
        lifecycle: permissionRequest('permission-1', 'incarnation-1'),
        decision: firstDecision,
      });
      lease.sink.publish({
        type: 'permission',
        runId: 'run-1',
        lifecycle: permissionRequest('permission-1', 'incarnation-2'),
        decision: secondDecision,
      });

      const first = ledger.claimPermissionResolution(permissionControl({
        incarnation: 'incarnation-1',
      }));
      ledger.completePermissionResolution(first, { allow: false });
      const second = ledger.claimPermissionResolution(permissionControl({
        incarnation: 'incarnation-2',
      }));

      expect(first.incarnation).toBe('incarnation-1');
      expect(first.decision).toBe(firstDecision);
      expect(second.incarnation).toBe('incarnation-2');
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
        lifecycle: permissionRequest('permission-1', 'incarnation-1'),
        decision: permissionDecision('permission-1', 'incarnation-1'),
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
        lifecycle: permissionRequest('permission-1', 'incarnation-1'),
        decision: permissionDecision('permission-1', 'incarnation-1'),
      });

      const claim = ledger.claimPermissionResolution(permissionControl());
      ledger.abandonPermissionResolution(claim);

      expect(ledger.claimPermissionResolution(permissionControl())).toMatchObject({
        requestId: 'permission-1',
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

function permissionRequest(requestId, incarnation) {
  return {
    kind: 'requested',
    requestId,
    incarnation,
    requestedTool: new BashToolUseMessage(TS, 'tool-1', 'pwd'),
    options: [],
  };
}

function permissionDecision(requestId, incarnation) {
  return {
    requestId,
    incarnation,
    respond: async () => undefined,
  };
}

function permissionControl(overrides = {}) {
  return {
    serverInstanceId: 'server-1',
    chatId: 'chat-1',
    runId: 'run-1',
    id: 'permission-1',
    incarnation: 'incarnation-1',
    ...overrides,
  };
}

function tick() {
  return new Promise((resolve) => queueMicrotask(resolve));
}
