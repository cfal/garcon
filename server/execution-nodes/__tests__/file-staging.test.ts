import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupAbandonedFileStaging, createFileStaging } from '../file-staging.js';
import { FileTransfers } from '../file-transfers.js';
import { LocalExecutionFilesService } from '../../files/service.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-file-staging-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function stagingFor(pid: number): Promise<string> {
  const own = await createFileStaging(root);
  const renamed = own.replace(`-${process.pid}-`, `-${pid}-`);
  await fs.rename(own, renamed);
  await fs.writeFile(path.join(renamed, 'content'), 'synthetic upload');
  return renamed;
}

test('cleanup removes only definitely dead same-host owners, not live, foreign or unowned staging', async () => {
  const live = await createFileStaging(root);
  const uncertainPid = 2147483646;
  const deadPid = 2147483647;
  const uncertain = await stagingFor(uncertainPid);
  const probe = spyOn(process, 'kill').mockImplementation(() => true);
  try {
    const dead = await stagingFor(deadPid);
    const foreign = path.join(root, 'transfer-v1-foreign-host-123-abcdef');
    const unknown = path.join(root, 'transfer-abcdef');
    await fs.mkdir(foreign);
    await fs.mkdir(unknown);
    probe.mockImplementation((pid) => {
      if (pid === deadPid || pid === uncertainPid) throw Object.assign(new Error('probe'), { code: pid === deadPid ? 'ESRCH' : 'EPERM' });
      return true;
    });
    await cleanupAbandonedFileStaging(root);
    expect((await fs.readdir(root)).sort()).toEqual([live, uncertain, foreign, unknown].map((entry) => path.basename(entry)).sort());
    await expect(fs.stat(dead)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(uncertain, 'content'), 'utf8')).toBe('synthetic upload');
    expect(probe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  } finally { probe.mockRestore(); }
});

test('failed abandoned cleanup rejects upload admission until cleanup succeeds', async () => {
  const abandoned = await stagingFor(2147483647);
  const remove = fs.rm;
  const intercepted = spyOn(fs, 'rm').mockImplementation(async (...args) => {
    if (args[0] === abandoned) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return remove(...args);
  });
  const files = new LocalExecutionFilesService({ nodeId: 'synthetic', projectBasePath: root });
  const transfers = new FileTransfers(files, { nodeId: 'synthetic', instanceId: 'generation', sessionId: 'session' }, { stagingRoot: root });
  const request = { projectPath: root, filePath: 'target.txt', expectedRevision: 'v1:initial', conflictResolution: 'overwrite' as const, size: 1 };
  try {
    for (let i = 0; i < 9; i++) await expect(transfers.beginWrite(request, new AbortController().signal)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fs.readdir(root)).toEqual([path.basename(abandoned)]);
    intercepted.mockRestore();
    const transfer = await transfers.beginWrite(request, new AbortController().signal);
    await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
    await transfers.close(transfer);
    expect(await fs.readdir(root)).toEqual([]);
  } finally { intercepted.mockRestore(); await transfers.dispose(); }
});

test('concurrent sweeps leave a live transfer available and ignore symlinks', async () => {
  const live = await createFileStaging(root);
  await fs.writeFile(path.join(live, 'content'), 'live');
  const abandoned = await stagingFor(2147483647);
  const alias = abandoned.replace('-2147483647-', '-2147483646-');
  await fs.symlink(live, alias);
  await Promise.all([cleanupAbandonedFileStaging(root), cleanupAbandonedFileStaging(root)]);
  expect(await fs.readFile(path.join(live, 'content'), 'utf8')).toBe('live');
  expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
});
