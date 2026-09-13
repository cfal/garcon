import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NodeCoordinatorLock } from '../systemd/coordinator-lock.js';

describe.skipIf(process.platform !== 'linux')('Linux coordinator storage', () => {

const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture() {
  const directory = await mkdtemp(path.join(homedir(), 'garcon-coordinator-lock-'));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'coordinator.lock');
  return { directory, file, async acquire() {
    const lock = await NodeCoordinatorLock.acquire(file);
    disposals.push(() => lock.release());
    return lock;
  } };
}

test('coordinator locks contend across independent opens and retain one inode through release', async () => {
  const f = await fixture();
  const first = await f.acquire();
  const before = await lstat(f.file);
  expect(before.mode & 0o777).toBe(0o600);
  await expect(f.acquire()).rejects.toThrow();
  first.release(); first.release();
  const next = await f.acquire();
  expect((await lstat(f.file)).ino).toBe(before.ino);
  expect(() => next.assertHeld()).not.toThrow();
  expect(() => first.assertHeld()).toThrow();
});

test('coordinator descriptors are close-on-exec and absent from a live native child', async () => {
  const f = await fixture();
  await f.acquire();
  let found = false;
  for (const descriptor of await readdir('/proc/self/fd')) {
    if (await readlink(`/proc/self/fd/${descriptor}`).catch(() => null) !== f.file) continue;
    const flags = (await readFile(`/proc/self/fdinfo/${descriptor}`, 'utf8')).match(/^flags:\s+([0-7]+)$/m);
    expect(flags).not.toBeNull();
    expect(Number.parseInt(flags![1]!, 8) & 0x80000).toBe(0x80000);
    found = true;
  }
  expect(found).toBe(true);
  const child = Bun.spawn([process.execPath, '-e', `
    import { readdirSync, readlinkSync } from 'node:fs';
    console.log(JSON.stringify(readdirSync('/proc/self/fd').flatMap((fd) => {
      try { return [readlinkSync('/proc/self/fd/' + fd)]; } catch { return []; }
    })));
  `], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
  const [code, output, diagnostic] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, diagnostic).toBe(0);
  expect(JSON.parse(output)).not.toContain(f.file);
}, 30_000);

test.each(['symlink', 'directory', 'permissions'])('unsafe coordinator lock %s is refused without rewriting it', async (kind) => {
  const f = await fixture();
  const foreign = path.join(f.directory, 'foreign');
  await writeFile(foreign, 'synthetic-retained', { mode: 0o600 });
  if (kind === 'symlink') await symlink(foreign, f.file);
  else if (kind === 'directory') await mkdir(f.file, { mode: 0o700 });
  else await writeFile(f.file, 'synthetic-retained', { mode: 0o644 });
  await expect(f.acquire()).rejects.toThrow();
  expect(await readFile(foreign, 'utf8')).toBe('synthetic-retained');
  expect((await lstat(f.file)).isSymbolicLink()).toBe(kind === 'symlink');
});

});
