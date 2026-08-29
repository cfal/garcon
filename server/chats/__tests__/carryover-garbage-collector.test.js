import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '../../../common/chat-types.js';
import { CarryOverGarbageCollector } from '../carryover-garbage-collector.ts';
import { CarryOverTranscriptStore } from '../carryover-transcript-store.ts';

const FIRST = '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e';
const SECOND = 'd5f2380b-6228-49f5-8484-b2d7e16380ab';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

describe('CarryOverGarbageCollector', () => {
  let workspaceDir;
  let store;
  let sessions;
  let journalRoots;
  let collector;
  let afterRegistrySnapshot;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-carryover-gc-'));
    store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    sessions = {};
    journalRoots = new Set();
    afterRegistrySnapshot = null;
    collector = new CarryOverGarbageCollector({
      registry: {
        listAllChats: () => {
          const snapshot = sessions;
          afterRegistrySnapshot?.();
          afterRegistrySnapshot = null;
          return snapshot;
        },
      },
      journal: { roots: () => new Set(journalRoots) },
      store,
    });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('keeps shared segments until their final chat root is deleted', async () => {
    await commitSegment(FIRST);
    await commitSegment(SECOND);
    const refs = [segmentRef(FIRST), segmentRef(SECOND)];
    sessions = {
      source: { carryOverSegments: refs },
      fork: { carryOverSegments: refs },
    };

    await collector.initialize();
    delete sessions.source;
    await collector.sweep();
    await expect(segmentStat(FIRST)).resolves.toBeDefined();
    await expect(segmentStat(SECOND)).resolves.toBeDefined();

    delete sessions.fork;
    await collector.sweep();
    await expect(segmentStat(FIRST)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(segmentStat(SECOND)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains journal roots and in-process writer roots during a sweep', async () => {
    await commitSegment(FIRST);
    journalRoots.add(FIRST);
    await collector.sweep();
    await expect(segmentStat(FIRST)).resolves.toBeDefined();

    journalRoots.clear();
    const prepared = await prepareSegment(SECOND);
    await prepared.commit();
    await collector.sweep();
    await expect(segmentStat(SECOND)).resolves.toBeDefined();

    prepared.releaseRoot();
    await collector.sweep();
    await expect(segmentStat(FIRST)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(segmentStat(SECOND)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a writer root until a sweep with a stale durable snapshot completes', async () => {
    const prepared = await prepareSegment(FIRST);
    await prepared.commit();

    afterRegistrySnapshot = () => {
      sessions = { source: { carryOverSegments: [segmentRef(FIRST)] } };
      prepared.releaseRoot();
    };

    await collector.sweep();
    await expect(segmentStat(FIRST)).resolves.toBeDefined();
  });

  it('defers and coalesces scheduled sweeps', async () => {
    const scheduledCallbacks = [];
    let sweepCount = 0;
    const scheduled = new CarryOverGarbageCollector({
      registry: { listAllChats: () => ({}) },
      journal: { roots: () => new Set() },
      store: {
        cleanupTemporary: async () => 0,
        sweep: async () => {
          sweepCount += 1;
          return {
            reachableSegmentCount: 0,
            unreachableSegmentCount: 0,
            removedSegmentCount: 0,
            compressedBytes: 0,
            declaredUncompressedBytes: 0,
            durationMs: 0,
          };
        },
      },
    }, { defer: (callback) => { scheduledCallbacks.push(callback); } });

    scheduled.schedule();
    scheduled.schedule();
    expect(sweepCount).toBe(0);
    expect(scheduledCallbacks).toHaveLength(1);

    scheduledCallbacks[0]();
    await Promise.resolve();
    expect(sweepCount).toBe(1);
  });

  it('cancels a pending sweep during shutdown', () => {
    const scheduledCallbacks = [];
    let cancelCount = 0;
    const scheduled = new CarryOverGarbageCollector({
      registry: { listAllChats: () => ({}) },
      journal: { roots: () => new Set() },
      store: {
        cleanupTemporary: async () => 0,
        sweep: async () => emptySweepResult(),
      },
    }, {
      defer: (callback) => {
        scheduledCallbacks.push(callback);
        return () => { cancelCount += 1; };
      },
    });

    scheduled.schedule();
    scheduled.shutdown();

    expect(scheduledCallbacks).toHaveLength(1);
    expect(cancelCount).toBe(1);
  });

  it('uses an unref-ed delayed timer by default', async () => {
    const fixture = path.join(import.meta.dir, 'fixtures', 'carryover-gc-scheduler.ts');
    const child = Bun.spawn([process.execPath, fixture], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 2_500);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('scheduled\n');
    expect(stderr).toBe('');
  }, 10_000);

  async function prepareSegment(id) {
    return store.prepareSegment({
      operationId: `operation:${id}`,
      id,
      seedSanitation: 'not-applicable',
      messages: [new UserMessage(TIMESTAMP, id)],
    });
  }

  async function commitSegment(id) {
    const prepared = await prepareSegment(id);
    await prepared.commit();
    prepared.releaseRoot();
  }

  function segmentStat(id) {
    return fs.stat(path.join(workspaceDir, 'carryover-transcripts', 'segments', id));
  }

  function emptySweepResult() {
    return {
      reachableSegmentCount: 0,
      unreachableSegmentCount: 0,
      removedSegmentCount: 0,
      compressedBytes: 0,
      declaredUncompressedBytes: 0,
      durationMs: 0,
    };
  }
});

function segmentRef(id) {
  return {
    id,
    agentId: 'codex',
    model: 'gpt',
    capturedAt: TIMESTAMP,
    storedMessageCount: 1,
    visibleMessageCount: 1,
    trailingHandoff: { agentId: 'claude', model: 'opus' },
  };
}
