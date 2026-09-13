import { afterEach, describe, expect, mock, test } from 'bun:test';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NodeSessionHostOwner, type NodeSessionHostOptions } from '../systemd/session-host.js';
import { NodeSessionMarkerFile } from '../systemd/session-marker.js';

describe.skipIf(process.platform !== 'linux')('Linux coordinator storage', () => {

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture() {
  const root = await mkdtemp(path.join(homedir(), 'garcon-host-storage-'));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const marker = await NodeSessionMarkerFile.acquire({ runtimeDirectory: root, nodeId: 'synthetic-node',
    controllerId: 'synthetic-controller', onCompromised() {} });
  disposals.push(() => marker.release());
  const finished = Promise.withResolvers<number>();
  const helper = mock<NonNullable<NodeSessionHostOptions['helper']>>(async (request) => {
    if (request.kind === 'inspect') return { kind: 'ready', identity: { ...request.launch,
      invocationId: 'c'.repeat(32), mainPid: 1234, controlGroup: `/synthetic/${request.launch.unitName}` } };
    return request.kind === 'stop' ? { kind: 'stopped' } : { kind: 'retired-inert' };
  });
  const spawn = mock<NodeSessionHostOptions['spawn']>(() => ({ exited: finished.promise, closeInput() {}, kill() {} }));
  const owner = new NodeSessionHostOwner({ nodeId: 'synthetic-node', marker, helper, spawn,
    command: ['/synthetic/worker'], exited() {} });
  await owner.reconcile();
  const directory = async () => path.join(path.dirname(marker.filePath), `worker-${(await marker.read())!.launch.launchId}`);
  return { marker, finished, helper, spawn, owner, directory };
}

test('spawn failure retains its real launch directory until exact inert retirement succeeds', async () => {
  const f = await fixture();
  f.spawn.mockImplementation(() => { throw new Error('Synthetic spawn failed'); });
  await expect(f.owner.launch()).rejects.toThrow('Synthetic spawn failed');
  const evidence = await f.marker.read();
  const directory = await f.directory();
  expect((await lstat(directory)).isDirectory()).toBe(true);
  f.helper.mockImplementationOnce(async () => { throw new Error('Synthetic cleanup unavailable'); });
  await expect(f.owner.reconcile()).rejects.toThrow('Synthetic cleanup unavailable');
  await expect(f.owner.launch()).rejects.toThrow();
  expect(await f.marker.read()).toEqual(evidence);
  expect((await lstat(directory)).isDirectory()).toBe(true);
  await f.owner.reconcile();
  expect(f.helper.mock.calls.at(-1)?.[0]).toEqual({ kind: 'retire-inert', launch: evidence!.launch });
  expect(await f.marker.read()).toBeNull();
  await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a rejected waiter exit observation keeps its real launch directory and blocks replacement after unit stop', async () => {
  const f = await fixture();
  const host = await f.owner.launch();
  await f.owner.confirm(host);
  const evidence = await f.marker.read();
  const directory = await f.directory();
  const stopping = f.owner.stop(host);
  const outcome = stopping.catch((error: unknown) => error);
  f.finished.reject(new Error('Synthetic exit observation lost'));
  expect(await outcome).toMatchObject({ message: 'Synthetic exit observation lost' });
  expect(f.helper.mock.calls.at(-1)?.[0]).toEqual({ kind: 'stop', identity: evidence!.identity });
  expect(await f.marker.read()).toEqual(evidence);
  expect((await lstat(directory)).isDirectory()).toBe(true);
  await expect(f.owner.launch()).rejects.toThrow();
});

});
