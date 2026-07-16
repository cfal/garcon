import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireWorkspaceLease, WorkspaceInUseError } from '../workspace-lease.js';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), label));
  directories.push(directory);
  return directory;
}

describe('workspace lease', () => {
  it('rejects a second owner and allows acquisition after release', async () => {
    const workspace = await temporaryDirectory('garcon-workspace-lease-');
    const first = await acquireWorkspaceLease(workspace, { retries: 0, staleMs: 2_000, updateMs: 1_000 });
    const contention = acquireWorkspaceLease(workspace, {
      retries: 0,
      staleMs: 2_000,
      updateMs: 1_000,
    });
    await expect(contention).rejects.toBeInstanceOf(WorkspaceInUseError);
    await expect(contention).rejects.toMatchObject({
      code: 'WORKSPACE_IN_USE',
      workspaceDir: workspace,
    });
    await first.release();
    const second = await acquireWorkspaceLease(workspace, { retries: 0 });
    await second.release();
  });

  it('canonicalizes symlinked workspace paths', async () => {
    const root = await temporaryDirectory('garcon-workspace-symlink-');
    const workspace = path.join(root, 'workspace');
    const alias = path.join(root, 'alias');
    const first = await acquireWorkspaceLease(workspace, { retries: 0 });
    await symlink(workspace, alias, 'dir');
    await expect(acquireWorkspaceLease(alias, { retries: 0 })).rejects.toThrow('already in use');
    await first.release();
  });

  it('allows distinct workspaces concurrently', async () => {
    const left = await temporaryDirectory('garcon-workspace-left-');
    const right = await temporaryDirectory('garcon-workspace-right-');
    const leftLease = await acquireWorkspaceLease(left, { retries: 0 });
    const rightLease = await acquireWorkspaceLease(right, { retries: 0 });
    await rightLease.release();
    await leftLease.release();
  });

  it('recovers a stale lease after the owning process is killed', async () => {
    const workspace = await temporaryDirectory('garcon-workspace-stale-');
    const holderPath = path.join(import.meta.dir, 'fixtures', 'workspace-lease-holder.ts');
    const holder = Bun.spawn([process.execPath, holderPath, workspace], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = holder.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain('ready');

    holder.kill(9);
    await holder.exited;
    const recovered = await acquireWorkspaceLease(workspace, {
      staleMs: 2_000,
      updateMs: 1_000,
      retries: 8,
    });

    await recovered.release();
  }, 10_000);
});
