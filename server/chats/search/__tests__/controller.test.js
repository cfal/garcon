import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});

