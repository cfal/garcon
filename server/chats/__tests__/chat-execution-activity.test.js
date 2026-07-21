import { describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { UserMessage } from '../../../common/chat-types.js';
import { ChatExecutionCoordinator } from '../../chat-execution/chat-execution-coordinator.js';
import { ChatExecutionActivity } from '../chat-execution-activity.js';
import { ChatNativeReloader } from '../chat-native-reload.js';
import { ChatViewStore } from '../chat-view-store.js';
import { ChatRunningError } from '../errors.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ChatExecutionActivity', () => {
  it('gates native reload throughout direct-turn preparation', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-execution-preparation-'));
    try {
      const activity = new ChatExecutionActivity({ isChatRunning: () => false });
      const views = new ChatViewStore(activity.isActive);
      const queue = new ChatExecutionCoordinator(
        workspaceDir,
        {
          runAgentTurn: mock(async () => undefined),
          abortSession: mock(async () => false),
          isChatRunning: mock(() => false),
    waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        {
          register: mock(async () => undefined),
          discard: mock(() => true),
          markFailed: mock(() => true),
          markUnconfirmed: mock(() => true),
        },
        {
          appendMessages: mock(async () => ({ generationId: 'generation-1', messages: [] })),
        },
        () => ({}),
        () => true,
      );
      activity.attachReservedExecutions(queue);
      const nativeSource = {
        loadNativeMessages: mock(async () => [
          new UserMessage('2026-07-17T00:00:00.000Z', 'native'),
        ]),
      };
      const reloader = new ChatNativeReloader(views, nativeSource, activity.isActive);

      const reservation = queue.reserveDirectTurn('chat-1');
      expect(activity.isActive('chat-1')).toBe(true);
      await expect(reloader.reloadFromNative('chat-1', 'manual-reload')).rejects.toBeInstanceOf(
        ChatRunningError,
      );
      expect(nativeSource.loadNativeMessages).not.toHaveBeenCalled();

      await queue.releaseDirectTurn(reservation);
      expect(activity.isActive('chat-1')).toBe(false);
      await expect(reloader.reloadFromNative('chat-1', 'manual-reload')).resolves.toMatchObject({
        mode: 'manual-reload',
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('rejects a held manual replacement when a real queue reservation wins during the read', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-execution-reload-race-'));
    try {
      const nativeStarted = deferred();
      const releaseNative = deferred();
      const activity = new ChatExecutionActivity({ isChatRunning: () => false });
      const views = new ChatViewStore(activity.isActive);
      const queue = new ChatExecutionCoordinator(
        workspaceDir,
        {
          runAgentTurn: mock(async () => undefined),
          abortSession: mock(async () => false),
          isChatRunning: mock(() => false),
          waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        {
          register: mock(async () => undefined),
          discard: mock(() => true),
          markFailed: mock(() => true),
          markUnconfirmed: mock(() => true),
        },
        {
          appendMessages: mock(async () => ({ generationId: 'generation-1', messages: [] })),
        },
        () => ({}),
        () => true,
      );
      activity.attachReservedExecutions(queue);
      const reloader = new ChatNativeReloader(
        views,
        {
          loadNativeMessages: mock(async () => {
            nativeStarted.resolve();
            await releaseNative.promise;
            return [new UserMessage('2026-07-17T00:00:00.000Z', 'native')];
          }),
        },
        activity.isActive,
      );

      const reload = reloader.reloadFromNative('chat-1', 'manual-reload');
      await nativeStarted.promise;
      const reservation = queue.reserveDirectTurn('chat-1');
      releaseNative.resolve();

      await expect(reload).rejects.toBeInstanceOf(ChatRunningError);
      expect(views.getCursor('chat-1')).toBeNull();
      await queue.releaseDirectTurn(reservation);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('pins transcript state and rejects manual reload throughout a queue handoff', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-execution-activity-'));
    try {
      let now = 0;
      let seq = 0;
      const pendingStarted = deferred();
      const releasePending = deferred();
      const activity = new ChatExecutionActivity({ isChatRunning: () => false });
      const views = new ChatViewStore(activity.isActive, {
        now: () => now,
        staleNonActiveMs: 1,
        recentViewRetentionCount: 0,
      });
      const queue = new ChatExecutionCoordinator(
        workspaceDir,
        {
          runAgentTurn: mock(async () => undefined),
          abortSession: mock(async () => false),
          isChatRunning: mock(() => false),
          waitUntilTurnAbortable: mock(() => Promise.resolve(true)),
        },
        {
          register: mock(async () => {
            pendingStarted.resolve();
            await releasePending.promise;
          }),
          discard: mock(() => true),
          markFailed: mock(() => true),
          markUnconfirmed: mock(() => true),
        },
        {
          appendMessages: mock(async (_chatId, messages) => ({
            generationId: 'generation-1',
            messages: messages.map((message) => ({ seq: ++seq, message })),
          })),
        },
        () => ({}),
        () => true,
      );
      activity.attachReservedExecutions(queue);
      const nativeSource = {
        loadNativeMessages: mock(async () => [
          new UserMessage('2026-07-17T00:00:00.000Z', 'native'),
        ]),
      };
      const reloader = new ChatNativeReloader(views, nativeSource, activity.isActive);
      const initial = await views.appendToCurrentOrEmpty('chat-1', [
        new UserMessage('2026-07-17T00:00:00.000Z', 'live'),
      ]);
      await queue.createChatQueueEntry('chat-1', 'queued');

      const drain = queue.triggerDrain('chat-1');
      await pendingStarted.promise;
      expect(activity.isActive('chat-1')).toBe(true);

      now = 10;
      views.prune();
      expect(views.getCursor('chat-1')).toEqual({
        generationId: initial.generationId,
        lastSeq: initial.lastSeq,
      });
      await expect(reloader.reloadFromNative('chat-1', 'manual-reload')).rejects.toBeInstanceOf(
        ChatRunningError,
      );
      expect(nativeSource.loadNativeMessages).not.toHaveBeenCalled();

      releasePending.resolve();
      await drain;
      expect(activity.isActive('chat-1')).toBe(false);

      now = 20;
      views.prune();
      expect(views.getCursor('chat-1')).toBeNull();
      await expect(reloader.reloadFromNative('chat-1', 'manual-reload')).resolves.toMatchObject({
        mode: 'manual-reload',
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
