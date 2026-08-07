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

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-carryover-gc-'));
    store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    sessions = {};
    journalRoots = new Set();
    collector = new CarryOverGarbageCollector({
      registry: { listAllChats: () => sessions },
      journal: { roots: () => new Set(journalRoots) },
      store,
    });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('keeps a shared chain until its final chat root is deleted', async () => {
    await commitNode(FIRST, null);
    await commitNode(SECOND, FIRST);
    sessions = {
      source: { carryOverHeadId: SECOND },
      fork: { carryOverHeadId: SECOND },
    };

    await collector.initialize();
    delete sessions.source;
    await collector.sweep();
    await expect(nodeStat(FIRST)).resolves.toBeDefined();
    await expect(nodeStat(SECOND)).resolves.toBeDefined();

    delete sessions.fork;
    await collector.sweep();
    await expect(nodeStat(FIRST)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(nodeStat(SECOND)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains journal roots and in-process writer roots during a sweep', async () => {
    await commitNode(FIRST, null);
    journalRoots.add(FIRST);
    await collector.sweep();
    await expect(nodeStat(FIRST)).resolves.toBeDefined();

    journalRoots.clear();
    const prepared = await prepareNode(SECOND, null);
    await prepared.commit();
    await collector.sweep();
    await expect(nodeStat(SECOND)).resolves.toBeDefined();

    prepared.releaseRoot();
    await collector.sweep();
    await expect(nodeStat(FIRST)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(nodeStat(SECOND)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  async function prepareNode(id, parentId) {
    return store.prepareMaterialized({
      operationId: `operation:${id}`,
      id,
      parentId,
      source: {
        agentId: 'codex',
        model: 'gpt',
        nativeSessionId: 'session',
        nativeRevision: `revision:${id}`,
      },
      boundary: {
        kind: 'handoff',
        targetAtCapture: { agentId: 'claude', model: 'opus' },
      },
      seedSanitation: 'not-applicable',
      messages: [new UserMessage(TIMESTAMP, id)],
    });
  }

  async function commitNode(id, parentId) {
    const prepared = await prepareNode(id, parentId);
    await prepared.commit();
    prepared.releaseRoot();
  }

  function nodeStat(id) {
    return fs.stat(path.join(workspaceDir, 'carryover-transcripts', 'nodes', id));
  }
});
