import { afterEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  cleanupOwnedGoalAttachments,
  materializeGoalDraft,
} from '../goal-files.ts';
import { recoverGoalDraftAfterError } from '../goal-recovery.ts';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Codex goal files', () => {
  it('removes materialized video files after their goal stops owning them', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-goal-files-'));
    tempDirs.push(codexHome);
    const draft = await materializeGoalDraft(codexHome, 'thread-1', 'Inspect the video', [{
      kind: 'image',
      data: `data:video/mp4;base64,${Buffer.from('video').toString('base64')}`,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
    }]);

    expect(draft.outputDir).not.toBeNull();
    expect(new Set(await fs.readdir(draft.outputDir))).toEqual(new Set(['.garcon-owner.json', 'file-1.mp4']));

    await cleanupOwnedGoalAttachments(codexHome, 'thread-1', null);

    await expect(fs.stat(draft.outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('only removes matching owned UUID directories and preserves the requested directory', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-goal-files-'));
    tempDirs.push(codexHome);
    const attachment = {
      kind: 'image',
      data: `data:video/mp4;base64,${Buffer.from('video').toString('base64')}`,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
    };
    const keep = await materializeGoalDraft(codexHome, 'thread-1', 'Keep', [attachment]);
    const stale = await materializeGoalDraft(codexHome, 'thread-1', 'Remove', [attachment]);
    const foreign = await materializeGoalDraft(codexHome, 'thread-2', 'Foreign', [attachment]);
    const attachmentRoot = path.join(codexHome, 'attachments');
    const malformed = path.join(attachmentRoot, '123e4567-e89b-42d3-a456-426614174000');
    const nonUuid = path.join(attachmentRoot, 'not-a-goal-directory');
    const symlinkTarget = path.join(codexHome, 'symlink-target');
    const symlink = path.join(attachmentRoot, '123e4567-e89b-42d3-a456-426614174001');
    await fs.mkdir(malformed);
    await fs.writeFile(path.join(malformed, '.garcon-owner.json'), '{invalid', 'utf8');
    await fs.mkdir(nonUuid);
    await fs.writeFile(path.join(nonUuid, '.garcon-owner.json'), JSON.stringify({ version: 1, threadId: 'thread-1' }), 'utf8');
    await fs.mkdir(symlinkTarget);
    await fs.writeFile(path.join(symlinkTarget, '.garcon-owner.json'), JSON.stringify({ version: 1, threadId: 'thread-1' }), 'utf8');
    await fs.symlink(symlinkTarget, symlink, 'dir');

    await cleanupOwnedGoalAttachments(codexHome, 'thread-1', keep.outputDir);

    await expect(fs.access(stale.outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await Promise.all([keep.outputDir, foreign.outputDir, malformed, nonUuid, symlinkTarget, symlink].map((entry) => fs.access(entry)));
  });

  it('preserves the provider failure when rejected-draft cleanup also fails', async () => {
    const deliveryError = new Error('provider response lost');
    const cleanupError = new Error('cleanup denied');
    const onCleanupError = mock(() => {});

    await expect(recoverGoalDraftAfterError(
      { getThreadGoal: async () => ({ goal: null }) },
      'thread-1',
      { objective: 'Attempted goal', outputDir: '/attachments/draft' },
      deliveryError,
      onCleanupError,
      async () => { throw cleanupError; },
    )).rejects.toBe(deliveryError);
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError);
  });

});
