import { afterEach, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NodeSessionMarkerFile, parseNodeSessionHostMarker } from '../systemd/session-marker.js';
import { systemdExecutionLaunch } from '../systemd/launch.js';

const nodeId = 'synthetic-node';
const controllerId = 'synthetic-controller';
const launch = systemdExecutionLaunch(nodeId, '/synthetic/bun', []).identity;
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
  const other = systemdExecutionLaunch(nodeId, '/synthetic/bun', []).identity;
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
  const foreign = systemdExecutionLaunch('synthetic-other-node', '/synthetic/bun', []).identity;
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
