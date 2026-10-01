import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cgroupAvailableBytes } from '../carryover-migration-budget.ts';

describe('cgroup memory allowance', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cgroup-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeScope(scope, { max, current }) {
    const scopeDir = path.join(dir, 'mount', scope);
    await fs.mkdir(scopeDir, { recursive: true });
    await fs.writeFile(path.join(scopeDir, 'memory.max'), `${max}\n`);
    await fs.writeFile(path.join(scopeDir, 'memory.current'), `${current}\n`);
  }

  async function fakeCgroup(scope, allowance) {
    await fs.writeFile(path.join(dir, 'self-cgroup'), `0::${scope}\n`);
    await writeScope(scope, allowance);
    return { selfCgroup: path.join(dir, 'self-cgroup'), mount: path.join(dir, 'mount') };
  }

  it('reports the remaining allowance under a finite limit', async () => {
    const roots = await fakeCgroup('/user.slice/app.scope', {
      max: 268_435_456,
      current: 16_404_480,
    });

    expect(await cgroupAvailableBytes(roots)).toBe(268_435_456 - 16_404_480);
  });

  it('reports no limit when the cgroup is unbounded', async () => {
    const roots = await fakeCgroup('/user.slice/app.scope', { max: 'max', current: 1_000 });

    // `null` means "no finite limit", which the caller uses to fall back to the
    // host figure rather than refusing every migration.
    expect(await cgroupAvailableBytes(roots)).toBeNull();
  });

  it('reports no limit rather than zero when the files are absent', async () => {
    expect(await cgroupAvailableBytes({
      selfCgroup: path.join(dir, 'missing'),
      mount: path.join(dir, 'missing'),
    })).toBeNull();
  });

  it('never reports a negative allowance when usage exceeds the limit', async () => {
    const roots = await fakeCgroup('/user.slice/app.scope', { max: 1_000, current: 5_000 });

    expect(await cgroupAvailableBytes(roots)).toBe(0);
  });

  it('uses a finite parent when the process cgroup is unbounded', async () => {
    const roots = await fakeCgroup('/parent/leaf', { max: 'max', current: 100 });
    await writeScope('/parent', { max: 1_000, current: 900 });

    expect(await cgroupAvailableBytes(roots)).toBe(100);
  });

  it('uses the smallest remaining allowance across the hierarchy', async () => {
    const roots = await fakeCgroup('/parent/leaf', { max: 5_000, current: 1_000 });
    await writeScope('/parent', { max: 1_000, current: 900 });

    expect(await cgroupAvailableBytes(roots)).toBe(100);
  });
});
