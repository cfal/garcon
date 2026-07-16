import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '../../../../common/chat-types.js';
import { TranscriptSearchController } from '../controller.js';

let tempDir = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

async function exists(filePath) {
  return Bun.file(filePath).exists();
}

describe('TranscriptSearchController', () => {
  it('keeps search closed and retries when disabled cleanup fails', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-controller-cleanup-'));
    const blockedPath = path.join(tempDir, 'chat-search-v3.sqlite');
    await mkdir(blockedPath);
    await writeFile(path.join(blockedPath, 'held'), 'blocked');
    let workerCount = 0;
    const controller = new TranscriptSearchController({
      workspaceDir: tempDir,
      listChats: () => [],
      resolveSearchLoadPlan: async () => ({ kind: 'live-only', reasonCode: 'test' }),
      getCarryOverDescriptor: () => null,
      cleanupRetryMs: 10,
      workerFactory: () => {
        workerCount += 1;
        throw new Error('worker must not start');
      },
    });

    await controller.initialize(false);
    expect(controller.runtimeState).toBe('degraded');
    expect(workerCount).toBe(0);

    await rm(blockedPath, { recursive: true });
    await Bun.sleep(30);
    expect(controller.runtimeState).toBe('disabled');
    expect(workerCount).toBe(0);
    await controller.close();
  });

  it('deletes indexes while disabled and rebuilds a fresh worker on enable', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-controller-'));
    const legacy = path.join(tempDir, 'chat-search.sqlite');
    const v3 = path.join(tempDir, 'chat-search-v3.sqlite');
    await writeFile(legacy, 'legacy');
    await writeFile(v3, 'derived');
    const controller = new TranscriptSearchController({
      workspaceDir: tempDir,
      listChats: () => [],
      resolveSearchLoadPlan: async () => ({ kind: 'live-only', reasonCode: 'test' }),
      getCarryOverDescriptor: () => null,
    });

    await controller.initialize(false);
    expect(controller.runtimeState).toBe('disabled');
    expect(await exists(legacy)).toBe(false);
    expect(await exists(v3)).toBe(false);

    await controller.start();
    expect(await exists(v3)).toBe(true);
    controller.appendMessages('c1', [
      new UserMessage('2026-01-01T00:00:00.000Z', 'controller live token'),
    ]);
    await Bun.sleep(300);
    const result = await controller.search({ query: 'controller', allowedChatIds: ['c1'] });
    expect(result.results.map((entry) => entry.chatId)).toEqual(['c1']);

    await controller.disableAndDelete();
    expect(controller.runtimeState).toBe('disabled');
    expect(await exists(v3)).toBe(false);
  });

  it('does not resurrect a chat deleted while its source plan is resolving', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-controller-race-'));
    const transcriptPath = path.join(tempDir, 'direct.jsonl');
    await writeFile(transcriptPath, JSON.stringify({
      role: 'user',
      content: 'resurrection token',
      timestamp: '2026-01-01T00:00:00.000Z',
    }));
    let chats = [{
      chatId: 'c1',
      lastActivityAt: null,
      agentId: 'direct-chat',
      model: 'test',
    }];
    let resolvePlan;
    const planRequested = new Promise((resolve) => {
      resolvePlan = resolve;
    });
    let releasePlan;
    const planGate = new Promise((resolve) => {
      releasePlan = resolve;
    });
    const controller = new TranscriptSearchController({
      workspaceDir: tempDir,
      listChats: () => chats,
      resolveSearchLoadPlan: async () => {
        resolvePlan();
        await planGate;
        return {
          kind: 'detached',
          source: { kind: 'direct-jsonl', nativePath: transcriptPath },
        };
      },
      getCarryOverDescriptor: () => null,
    });
    await controller.start();
    await planRequested;
    chats = [];
    controller.deleteChat('c1');
    releasePlan();
    await Bun.sleep(100);
    const result = await controller.search({ query: 'resurrection', allowedChatIds: ['c1'] });
    expect(result.results).toEqual([]);
    await controller.close();
  });
});
