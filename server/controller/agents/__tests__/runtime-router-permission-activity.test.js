import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentCallError } from '@garcon/server-agent-interface';
import { BashToolUseMessage } from '../../../../common/chat-types.ts';
import { ChatTransientFeedStore } from '../../chats/chat-transient-feed.ts';
import { projectChatActivityStatus } from '../../chats/chat-activity-status.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { PermissionNotActionableError } from '../../ledger/errors.ts';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { permissionFixture, permissionResponse } from './producer-fixture.ts';

const AT = '2026-08-16T00:00:00.000Z';
const OCCURRENCE_ID = '11111111-1111-4111-8111-111111111111';
const control = {
  serverInstanceId: 'server-1', chatId: 'chat-1', runId: 'run-1', permissionOccurrenceId: OCCURRENCE_ID,
};

describe('permission response activity', () => {
  it('advertises working throughout a claimed response and never restores a completed control', async () => {
    await withPermission(async (fixture) => {
      const response = fixture.resolve();
      await fixture.started.promise;
      expect(fixture.activity()).toBe('working');
      expect(fixture.feed.currentSnapshot('chat-1').rows).toHaveLength(1);
      expect(fixture.feed.validateAction(control).permissionOccurrenceId).toBe(OCCURRENCE_ID);
      await expect(fixture.resolve()).rejects.toBeInstanceOf(PermissionNotActionableError);
      fixture.release.resolve();
      await response;
      await Promise.resolve();
      expect(fixture.activity()).toBe('working');
      expect(fixture.feed.currentSnapshot('chat-1').rows).toEqual([]);
      expect(fixture.ledger.currentRows('chat-1').map(row => row.kind)).toEqual([
        'permission-requested', 'permission-resolved',
      ]);
      expect(fixture.actionability.mock.calls.map(([event]) => event.actionability)).toEqual(['claimed']);
    });
  });

  it('restores the exact live control only after definite non-dispatch', async () => {
    await withPermission(async (fixture) => {
      const original = fixture.feed.validateAction(control);
      const response = fixture.resolve();
      await fixture.started.promise;
      expect(fixture.activity()).toBe('working');
      fixture.release.reject(new AgentCallError('not-dispatched', 'Synthetic unavailable response'));
      await expect(response).rejects.toThrow('Synthetic unavailable response');
      expect(fixture.activity()).toBe('pending-user-action');
      expect(fixture.feed.validateAction(control)).toBe(original);
      expect(fixture.actionability.mock.calls.map(([event]) => event.actionability)).toEqual(['claimed', 'actionable']);
      expect(fixture.ledger.currentRows('chat-1').map(row => row.kind)).toEqual(['permission-requested']);
      const retry = fixture.ledger.claimPermissionResolution(control);
      fixture.ledger.completePermissionResolution(retry, { allow: true });
      await Promise.resolve();
      expect(fixture.activity()).toBe('working');
    });
  });

  for (const failure of [
    new AgentCallError('unknown', 'Synthetic uncertain response'),
    new AgentCallError('rejected', 'Synthetic expired response'),
    new Error('Synthetic interrupted response'),
  ]) {
    it(`keeps a claimed control unavailable after ${failure.message}`, async () => {
      await withPermission(async (fixture) => {
        const response = fixture.resolve();
        await fixture.started.promise;
        expect(fixture.activity()).toBe('working');
        fixture.release.reject(failure);
        await expect(response).rejects.toBe(failure);
        await Promise.resolve();
        expect(fixture.activity()).toBe('working');
        expect(fixture.feed.currentSnapshot('chat-1').rows).toEqual([]);
        await expect(fixture.resolve()).rejects.toBeInstanceOf(PermissionNotActionableError);
        expect(fixture.actionability.mock.calls.map(([event]) => event.actionability)).toEqual(['claimed']);
        expect(fixture.ledger.currentRows('chat-1').map(row => row.kind)).toEqual(['permission-requested']);
      });
    });
  }

  it('does not revive a permission after its run ends during a definitely undispatched response', async () => {
    await withPermission(async (fixture) => {
      const response = fixture.resolve();
      await fixture.started.promise;
      fixture.ledger.interruptRun('chat-1');
      fixture.release.reject(new AgentCallError('not-dispatched', 'Synthetic abandoned response'));
      await expect(response).rejects.toThrow('Synthetic abandoned response');
      await Promise.resolve();
      expect(fixture.feed.currentSnapshot('chat-1').rows).toEqual([]);
      expect(fixture.activity()).toBeNull();
      expect(fixture.actionability.mock.calls.map(([event]) => event.actionability)).toEqual(['claimed']);
    });
  });

  it('releases actionability subscriptions on unsubscribe and ledger close', async () => {
    await withPermission(async (fixture) => {
      const listener = mock(() => undefined);
      const unsubscribe = fixture.ledger.subscribePermissionActionabilityChanged(listener);
      const first = fixture.ledger.claimPermissionResolution(control);
      fixture.ledger.abandonPermissionResolution(first);
      unsubscribe();
      const second = fixture.ledger.claimPermissionResolution(control);
      fixture.ledger.abandonPermissionResolution(second);
      expect(listener).toHaveBeenCalledTimes(2);
      const closeListener = mock(() => undefined);
      fixture.ledger.subscribePermissionActionabilityChanged(closeListener);
      fixture.ledger.close();
      fixture.ledger.abandonPermissionResolution(second);
      expect(closeListener).not.toHaveBeenCalled();
    });
  });
});

async function withPermission(check) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-activity-'));
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(root), { serverInstanceId: 'server-1' });
  const feed = new ChatTransientFeedStore('server-1');
  const actionability = mock((event) => feed.applyPermissionActionability(event));
  ledger.subscribe(event => { feed.apply(event); });
  ledger.subscribePermissionRetired(control => { feed.retirePermission(control); });
  ledger.subscribePermissionActionabilityChanged(actionability);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  try {
    const view = ledger.initializeChat('chat-1');
    const producer = ledger.openProducer('chat-1', 'test');
    ledger.beginRun('chat-1', 'run-1');
    producer.sink.publish({
      type: 'permission', runId: 'run-1',
      lifecycle: {
        kind: 'requested', permissionOccurrenceId: OCCURRENCE_ID,
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'), options: [],
      },
      decision: { permissionOccurrenceId: OCCURRENCE_ID, response: permissionResponse(OCCURRENCE_ID) },
    });
    await Promise.resolve();
    const router = new AgentRuntimeRouter({
      resolveFileMentions: async command => command,
      registry: { getChat: () => ({ agentId: 'test' }) },
      directory: {
        require: () => ({ permissions: permissionFixture(new Map([[OCCURRENCE_ID, async () => {
          started.resolve();
          await release.promise;
        }]])) }),
      },
      events: {},
      ledger,
      adoption: { ensure: async () => view },
    });
    const activity = () => projectChatActivityStatus({
      processingPhase: ledger.isRunActive('chat-1', 'run-1') ? 'running' : null,
      pendingUserAction: feed.hasPendingUserAction('chat-1'),
      lastRunOutcome: null,
    });
    expect(activity()).toBe('pending-user-action');
    await check({
      ledger, feed, actionability, started, release, activity,
      resolve: () => router.resolvePermission('chat-1', OCCURRENCE_ID, { allow: true }, control),
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}
