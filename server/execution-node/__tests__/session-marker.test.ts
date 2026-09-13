import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NodeSessionMarkerFile, parseNodeSessionHostMarker } from '../systemd/session-marker.js';
import { createSystemdLaunchIdentity } from '../systemd/launch.js';

describe.skipIf(process.platform !== 'linux')('Linux coordinator storage', () => {

const nodeId = 'synthetic-node';
const controllerId = 'synthetic-controller';
const launch = createSystemdLaunchIdentity(nodeId);
const identity = { ...launch, invocationId: 'c'.repeat(32), mainPid: 1234,
  controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${launch.unitName}` };
const marker = { version: 1 as const, nodeId, controllerId, launch, identity: null };
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture() {
  const directory = await mkdtemp(path.join(homedir(), 'garcon-session-marker-'));
  await chmod(directory, 0o700);
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  const options = { runtimeDirectory: directory, nodeId, controllerId, onCompromised() {} };
  const file = await NodeSessionMarkerFile.acquire(options);
  disposals.push(() => file.release());
  return { file, options, directory };
}

test('launch and full incarnation evidence survive coordinator reopening with private permissions', async () => {
  const f = await fixture();
  expect(await f.file.read()).toBeNull();
  await f.file.recordLaunch(launch);
  expect(await f.file.read()).toEqual(marker);
  await f.file.recordIdentity(identity);
  expect((await lstat(f.file.filePath)).mode & 0o777).toBe(0o600);
  expect((await lstat(path.dirname(f.file.filePath))).mode & 0o777).toBe(0o700);
  await f.file.release();
  const reopened = await NodeSessionMarkerFile.acquire(f.options);
  disposals.push(() => reopened.release());
  expect(await reopened.read()).toEqual({ ...marker, identity });
  await reopened.clear(identity);
  expect(await reopened.read()).toBeNull();
});

test('one node namespace cannot be held by two coordinator incarnations or controller identities', async () => {
  const f = await fixture();
  await expect(NodeSessionMarkerFile.acquire(f.options)).rejects.toThrow();
  await expect(NodeSessionMarkerFile.acquire({ ...f.options, controllerId: 'synthetic-other-controller' })).rejects.toThrow();
  await f.file.recordLaunch(launch);
  await f.file.release();
  const other = await NodeSessionMarkerFile.acquire({ ...f.options, controllerId: 'synthetic-other-controller' });
  disposals.push(() => other.release());
  await expect(other.read()).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
  expect(JSON.parse(await readFile(f.file.filePath, 'utf8'))).toEqual(marker);
});

test('a pending marker cannot be overwritten by concurrent or newer launch attempts', async () => {
  const f = await fixture();
  const other = createSystemdLaunchIdentity(nodeId);
  const first = f.file.recordLaunch(launch);
  const second = f.file.recordLaunch(other);
  await first;
  await expect(second).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
  expect(await f.file.read()).toEqual(marker);
});

test('identity promotion and cleanup must name the recorded exact launch', async () => {
  const f = await fixture();
  await f.file.recordLaunch(launch);
  await expect(f.file.recordIdentity({ ...identity, launchId: 'd'.repeat(32) })).rejects.toThrow();
  await expect(f.file.clear({ ...launch, launchId: 'd'.repeat(32) })).rejects.toThrow();
  await f.file.recordIdentity(identity);
  await expect(f.file.recordIdentity({ ...identity, invocationId: 'e'.repeat(32) })).rejects.toThrow();
  expect(await f.file.read()).toEqual({ ...marker, identity });
});

test('another node unit name cannot be recorded in this node namespace', async () => {
  const f = await fixture();
  const foreign = createSystemdLaunchIdentity('synthetic-other-node');
  await expect(f.file.recordLaunch(foreign)).rejects.toThrow();
  expect(await f.file.read()).toBeNull();
  expect(parseNodeSessionHostMarker({ ...marker, launch: foreign })).toBeNull();
});

test('release waits for issued marker writes and rejects further use', async () => {
  const f = await fixture();
  const written = f.file.recordLaunch(launch);
  const released = f.file.release();
  await expect(f.file.read()).rejects.toThrow();
  await written;
  await released;
  expect(JSON.parse(await readFile(f.file.filePath, 'utf8'))).toEqual(marker);
});

test('malformed or oversized markers fence admission without replacing their evidence', async () => {
  const f = await fixture();
  for (const body of ['{', 'x'.repeat(16_385), JSON.stringify({ ...marker, credential: 'synthetic-secret' }),
    JSON.stringify({ ...marker, nodeId: 'synthetic-other-node' })]) {
    await writeFile(f.file.filePath, body, { mode: 0o600 });
    await expect(f.file.read()).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
    await expect(f.file.recordLaunch(launch)).rejects.toThrow();
    expect(await readFile(f.file.filePath, 'utf8')).toBe(body);
  }
});

test('marker symlinks, hard links and public permissions cannot become cleanup evidence', async () => {
  const f = await fixture();
  const target = path.join(f.directory, 'synthetic-evidence.json');
  await writeFile(target, JSON.stringify(marker), { mode: 0o600 });
  await symlink(target, f.file.filePath);
  await expect(f.file.read()).rejects.toThrow();
  await unlink(f.file.filePath);
  await link(target, f.file.filePath);
  await expect(f.file.read()).rejects.toThrow();
  await unlink(f.file.filePath);
  await writeFile(f.file.filePath, JSON.stringify(marker), { mode: 0o644 });
  await expect(f.file.read()).rejects.toThrow();
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(marker);
});

test('a public or symlinked runtime root cannot acquire an execution namespace', async () => {
  const f = await fixture();
  await f.file.release();
  await chmod(f.directory, 0o755);
  await expect(NodeSessionMarkerFile.acquire(f.options)).rejects.toThrow();
  await chmod(f.directory, 0o700);
  const target = path.join(f.directory, 'runtime-link');
  await symlink(f.directory, target);
  await expect(NodeSessionMarkerFile.acquire({ ...f.options, runtimeDirectory: target })).rejects.toThrow();
});

test('marker parsing requires exact own fields and one matching full incarnation', () => {
  expect(parseNodeSessionHostMarker(marker)).toEqual(marker);
  expect(parseNodeSessionHostMarker({ ...marker, identity })).toEqual({ ...marker, identity });
  for (const value of [{ ...marker, version: 2 }, { ...marker, identity: { ...identity, launchId: 'd'.repeat(32) } },
    Object.assign(Object.create({ nodeId }), { version: 1, controllerId, launch, identity: null, foreign: true }),
    { ...marker, launch: Object.assign(Object.create({ unitName: launch.unitName }), { launchId: launch.launchId, foreign: true }) }]) {
    expect(parseNodeSessionHostMarker(value)).toBeNull();
  }
});

test('one empty private helper cwd survives evidence cleanup and namespace reopening', async () => {
  const f = await fixture();
  const directory = f.file.helperWorkingDirectory;
  const before = await lstat(directory);
  expect(path.dirname(directory)).toBe(path.dirname(f.file.filePath));
  expect(before.mode & 0o777).toBe(0o700);
  expect(await readdir(directory)).toEqual([]);
  await f.file.recordLaunch(launch);
  await f.file.clear(launch);
  await f.file.release();
  const reopened = await NodeSessionMarkerFile.acquire(f.options);
  disposals.push(() => reopened.release());
  expect(reopened.helperWorkingDirectory).toBe(directory);
  expect((await lstat(directory)).ino).toBe(before.ino);
  expect((await readdir(path.dirname(directory))).sort()).toEqual(['.coordinator.lock', 'helper-cwd']);
});

test('launch-owned worker directories survive reopening and exact cleanup leaves unrelated roots intact', async () => {
  const f = await fixture();
  const directory = await f.file.recordLaunch(launch);
  expect(directory).toBe(path.join(path.dirname(f.file.filePath), `worker-${launch.launchId}`));
  expect(JSON.parse(await readFile(f.file.filePath, 'utf8')).launch).toEqual(launch);
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  await mkdir(path.join(directory, 'instance-synthetic-first'), { mode: 0o700 });
  await mkdir(path.join(directory, 'instance-synthetic-second'), { mode: 0o700 });
  const unrelated = path.join(path.dirname(directory), 'worker-unowned');
  await mkdir(unrelated, { mode: 0o700 });
  await f.file.release();
  const reopened = await NodeSessionMarkerFile.acquire(f.options);
  disposals.push(() => reopened.release());
  await reopened.clear(launch);
  await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await lstat(unrelated)).isDirectory()).toBe(true);
  expect(await reopened.read()).toBeNull();
});

test.each(['contents', 'symlink', 'unknown-directory', 'permissions'])('unsafe worker cwd %s keeps its exact cleanup evidence', async (kind) => {
  const f = await fixture();
  const directory = await f.file.recordLaunch(launch);
  const child = path.join(directory, kind === 'unknown-directory' ? 'unexpected' : 'instance-synthetic');
  const foreign = path.join(f.directory, 'foreign-worker');
  await mkdir(foreign, { mode: 0o700 });
  await writeFile(path.join(foreign, 'retained'), 'synthetic-foreign-content');
  if (kind === 'symlink') await symlink(foreign, child);
  else {
    await mkdir(child, { mode: kind === 'permissions' ? 0o755 : 0o700 });
    if (kind === 'contents') await writeFile(path.join(child, '.env'), 'SYNTHETIC=retained');
  }
  await expect(f.file.clear(launch)).rejects.toThrow();
  expect(await f.file.read()).toEqual(marker);
  expect((await lstat(child)).isSymbolicLink()).toBe(kind === 'symlink');
  expect(await readFile(path.join(foreign, 'retained'), 'utf8')).toBe('synthetic-foreign-content');
  if (kind === 'contents') expect(await readFile(path.join(child, '.env'), 'utf8')).toBe('SYNTHETIC=retained');
});

test.each(['empty', 'populated'])('a preexisting %s worker root cannot become a cleanup target', async (kind) => {
  const f = await fixture();
  const directory = path.join(path.dirname(f.file.filePath), `worker-${launch.launchId}`);
  await mkdir(directory, { mode: 0o700 });
  if (kind === 'populated') await writeFile(path.join(directory, 'foreign'), 'synthetic-foreign-content');
  await expect(f.file.recordLaunch(launch)).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
  expect(await f.file.read()).toBeNull();
  await f.file.clear(launch);
  expect((await lstat(directory)).isDirectory()).toBe(true);
  if (kind === 'populated') expect(await readFile(path.join(directory, 'foreign'), 'utf8')).toBe('synthetic-foreign-content');
});

test.each(['contents', 'symlink', 'permissions'])('unsafe helper cwd %s is preserved and its newly acquired lock is released', async (kind) => {
  const f = await fixture();
  const directory = f.file.helperWorkingDirectory;
  await f.file.release();
  const foreign = path.join(f.directory, 'foreign');
  if (kind === 'contents') await writeFile(path.join(directory, '.env'), 'SYNTHETIC=retained');
  else if (kind === 'permissions') await chmod(directory, 0o755);
  else { await mkdir(foreign, { mode: 0o700 }); await rm(directory, { recursive: true }); await symlink(foreign, directory); }
  await expect(NodeSessionMarkerFile.acquire(f.options)).rejects.toThrow();
  expect((await readdir(path.dirname(directory))).sort()).toEqual(['.coordinator.lock', 'helper-cwd']);
  if (kind === 'contents') {
    expect(await readFile(path.join(directory, '.env'), 'utf8')).toBe('SYNTHETIC=retained');
    await unlink(path.join(directory, '.env'));
  } else if (kind === 'permissions') {
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    await chmod(directory, 0o700);
  } else {
    expect((await lstat(directory)).isSymbolicLink()).toBe(true);
    await unlink(directory); await mkdir(directory, { mode: 0o700 });
  }
  const repaired = await NodeSessionMarkerFile.acquire(f.options);
  disposals.push(() => repaired.release());
  expect(await repaired.read()).toBeNull();
});

});
