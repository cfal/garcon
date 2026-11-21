import { describe, expect, it, spyOn } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createSessionFixture, holdSettingsReply } from './thread-settings-fixture.js';

const startSession = createSessionFixture({ retainedSourceIdlePurge: { intervalMs: 5, maxIdleMs: 0 } });

async function idleSource() {
  const session = await startSession('standard');
  session.first.finish();
  return session;
}

async function expectReclaimed(shutdown: () => unknown) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (shutdown()) return;
    await Bun.sleep(5);
  }
  throw new Error('Idle source was not reclaimed');
}

describe('retained Codex source settings lifetime', () => {
  it('settles settings that arrive during native-path resolution before replacing the writer', async () => {
    const { runtime, request, resume, clients, first } = await idleSource();
    const nativeContents = await readFile(resume.nativePath, 'utf8');
    await rm(resume.nativePath);
    const pathRequested = Promise.withResolvers<void>();
    const pathReply = Promise.withResolvers<void>();
    spyOn(runtime, 'resolveNativePath').mockImplementation(async () => {
      pathRequested.resolve();
      await pathReply.promise;
      return resume.nativePath;
    });
    const settings = holdSettingsReply(first.update);
    const resumed = runtime.runTurn({ ...resume, speed: 'ultrafast' });
    let update: Promise<void> | undefined;
    try {
      await pathRequested.promise;
      await writeFile(resume.nativePath, nativeContents);
      update = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'medium' });
      await settings.confirmed;
      pathReply.resolve();
      await Bun.sleep(25);
      expect(first.shutdown).not.toHaveBeenCalled();
      expect(clients).toHaveLength(1);
      settings.release();
      await update;
      await resumed;
      expect(first.shutdown).toHaveBeenCalledTimes(1);
      expect(clients).toHaveLength(2);
    } finally {
      pathReply.resolve();
      settings.release();
      await update;
      await resumed;
    }
  });

  it.each(['settings only', 'standard', 'ultrafast'] as const)(
    'retains the source until the confirmed settings RPC settles before %s', async (action) => {
      const { runtime, request, resume, clients, first } = await idleSource();
      const settings = holdSettingsReply(first.update);
      const update = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'medium' });
      let resumed: Promise<void> | undefined;
      try {
        await settings.confirmed;
        if (action !== 'settings only') resumed = runtime.runTurn({ ...resume, speed: action });
        runtime.startPurgeTimer();
        await Bun.sleep(30);
        expect(first.shutdown).not.toHaveBeenCalled();
        expect(clients).toHaveLength(1);
        expect(first.startTurn).toHaveBeenCalledTimes(1);
        settings.release();
        await update;
        await resumed;
        if (action === 'standard') expect(first.startTurn).toHaveBeenCalledTimes(2);
        if (action === 'ultrafast') expect(clients).toHaveLength(2);
        clients.at(-1)!.finish();
        await expectReclaimed(() => clients.at(-1)!.shutdown.mock.calls.length > 0);
      } finally {
        settings.release();
        await update;
        await resumed;
      }
    },
  );

  it.each(['release', 'cancel', 'queued write', 'competing turn'] as const)(
    'rechecks admission and queued writes after settings settle: %s', async (action) => {
      const { runtime, request, resume, clients, first } = await idleSource();
      const settings = holdSettingsReply(first.update);
      const update = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'medium' });
      await settings.confirmed;
      const controller = new AbortController();
      const resumed = runtime.runTurn({ ...resume, speed: action === 'competing turn' ? 'standard' : 'ultrafast',
        executionAdmission: { signal: controller.signal, async markStarted() {} } })
        .then(() => null, (error: unknown) => error);
      let queued: Promise<unknown> | undefined;
      try {
        if (action === 'release') {
          queued = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'high' })
            .then(() => null, (error: unknown) => error);
          await runtime.releaseSession(request.chatId, 'thread-1');
        } else if (action === 'cancel') {
          controller.abort(new Error('Admission cancelled'));
        } else if (action === 'competing turn') {
          queued = runtime.runTurn({ ...resume, operation: { ...resume.operation, runId: 'run-3' } })
            .then(() => null, (error: unknown) => error);
        } else {
          queued = runtime.updateSessionSettings('thread-1', { ...request, thinkingMode: 'high' });
        }
        settings.release();
        await update;
        if (action === 'release') {
          expect(await resumed).toMatchObject({ code: 'SESSION_BUSY' });
          expect(await queued).toMatchObject({ code: 'SESSION_BUSY' });
          expect(first.update).toHaveBeenCalledTimes(1);
        } else if (action === 'cancel') {
          expect(await resumed).toMatchObject({ message: 'Admission cancelled' });
        } else if (action === 'competing turn') {
          expect(await resumed).toBeNull();
          expect(await queued).toMatchObject({ code: 'SESSION_BUSY' });
          expect(first.startTurn).toHaveBeenCalledTimes(2);
        } else {
          await queued;
          expect(await resumed).toBeNull();
          expect(first.update).toHaveBeenCalledTimes(2);
          expect(clients).toHaveLength(2);
        }
        if (action !== 'queued write') expect(clients).toHaveLength(1);
      } finally {
        settings.release();
        await update;
        await queued;
        await resumed;
      }
    },
  );
});
