import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { systemdExecutionLaunch } from '../../../server/execution-node/systemd/launch.js';
import { runSystemdHelper } from '../../../server/execution-node/systemd/helper-process.js';
import type { SystemdUnitIdentity } from '../../../server/execution-node/systemd/contracts.js';

const available = process.platform === 'linux' && spawnSync('systemctl', ['--user', 'is-system-running'], {
  stdio: 'ignore', timeout: 2_000,
}).status === 0;
const processFixture = `${import.meta.dir}/../../support/systemd-owned-process.ts`;

async function start(nodeId: string) {
  const launch = systemdExecutionLaunch(nodeId, process.execPath, [processFixture]);
  const argv = [...launch.argv];
  argv.splice(argv.indexOf('--'), 0, '--property=RuntimeMaxSec=15s');
  const waiter = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  let identity: SystemdUnitIdentity | null = null;
  try {
    const reader = waiter.stdout.getReader();
    let announcement = '';
    try {
      while (!announcement.includes('\n')) {
        const next = await reader.read();
        if (next.done || announcement.length > 1_024) throw new Error('Synthetic service did not announce startup');
        announcement += new TextDecoder().decode(next.value);
      }
    } finally { reader.releaseLock(); }
    const pids = JSON.parse(announcement) as { mainPid: number; childPid: number };
    const inspected = await runSystemdHelper({ kind: 'inspect', launch: launch.identity });
    if (inspected.kind !== 'ready') throw new Error('Expected inspected execution identity');
    identity = inspected.identity;
    expect(identity.mainPid).toBe(pids.mainPid);
    const nativeInvocation = spawnSync('systemctl', ['--user', 'show', identity.unitName, '--property=InvocationID', '--value'], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096,
    });
    expect(nativeInvocation.status, nativeInvocation.stderr).toBe(0);
    expect(identity.invocationId).toBe(nativeInvocation.stdout.trim());
    expect(await readFile(`/proc/${pids.childPid}/cgroup`, 'utf8')).toContain(identity.controlGroup);
    const childStat = await readFile(`/proc/${pids.childPid}/stat`, 'utf8');
    expect(Number(childStat.slice(childStat.lastIndexOf(')') + 2).split(' ')[3])).toBe(pids.childPid);
    return { identity, waiter, pids, launch,
      async dispose() {
        expect(await runSystemdHelper({ kind: 'stop', identity: inspected.identity })).toEqual({ kind: 'stopped' });
        await waiter.exited;
        expect(existsSync(`/sys/fs/cgroup${inspected.identity.controlGroup}`)).toBe(false);
      },
    };
  } catch (error) {
    if (identity) await runSystemdHelper({ kind: 'stop', identity }).catch(() => {});
    // RuntimeMaxSec bounds the exact synthetic service even when startup validation fails.
    await waiter.exited;
    throw error;
  }
}

describe.skipIf(!available)('execution-node systemd containment (requires Linux user manager)', () => {
  test('a never-created inert launch retires without confusing absence with a failed bus', async () => {
    const launch = systemdExecutionLaunch(`synthetic-${randomUUID()}`, process.execPath, [processFixture, 'inert']);
    expect(await runSystemdHelper({ kind: 'retire-inert', launch: launch.identity })).toEqual({ kind: 'retired-inert' });
  }, 10_000);

  test('an inert launch is retired on its exact nonce without requiring persisted running identity', async () => {
    const launch = systemdExecutionLaunch(`synthetic-${randomUUID()}`, process.execPath, [processFixture, 'inert']);
    const waiter = Bun.spawn([...launch.argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    const reader = waiter.stdout.getReader();
    try {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      expect(new TextDecoder().decode(value)).toContain('mainPid');
      await expect(runSystemdHelper({ kind: 'retire-inert', launch: { ...launch.identity, launchId: 'd'.repeat(32) } }))
        .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
      expect(waiter.exitCode).toBeNull();
      expect(await runSystemdHelper({ kind: 'retire-inert', launch: launch.identity })).toEqual({ kind: 'retired-inert' });
      await waiter.exited;
      expect(await runSystemdHelper({ kind: 'retire-inert', launch: launch.identity })).toEqual({ kind: 'retired-inert' });
    } finally {
      reader.releaseLock();
      waiter.stdin.end();
      await runSystemdHelper({ kind: 'retire-inert', launch: launch.identity });
      await waiter.exited;
    }
  }, 30_000);

  test('a delayed inert launch cannot replace an already confirmed successor after absence reconciliation', async () => {
    const nodeId = `synthetic-${randomUUID()}`;
    const old = systemdExecutionLaunch(nodeId, process.execPath, [processFixture, 'inert']);
    expect(await runSystemdHelper({ kind: 'retire-inert', launch: old.identity })).toEqual({ kind: 'retired-inert' });
    const next = await start(nodeId);
    try {
      const late = Bun.spawn([...old.argv], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      expect(await late.exited).not.toBe(0);
      expect(next.waiter.exitCode).toBeNull();
      expect(await runSystemdHelper({ kind: 'inspect', launch: next.launch.identity })).toEqual({ kind: 'ready', identity: next.identity });
      await expect(runSystemdHelper({ kind: 'retire-inert', launch: old.identity }))
        .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
    } finally { await next.dispose(); }
  }, 30_000);

  test('passes launch arguments without systemd environment expansion', async () => {
    const args = ['literal;$(command)', '${GARCON_SYNTHETIC_UNSET}', '$GARCON_SYNTHETIC_UNSET', 'argument with spaces', ''];
    const launch = systemdExecutionLaunch(`synthetic-${randomUUID()}`, process.execPath,
      [processFixture, 'argv', ...args]);
    const argv = [...launch.argv];
    argv.splice(argv.indexOf('--'), 0, '--property=RuntimeMaxSec=5s');
    const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, diagnostic).toBe(0);
    expect(JSON.parse(output)).toEqual(args);
  }, 10_000);

  test('rejects concurrent launches and stale cleanup while containing a setsid child', async () => {
    const nodeId = `synthetic-${randomUUID()}`;
    const first = await start(nodeId);
    try {
      const competing = systemdExecutionLaunch(nodeId, '/usr/bin/true', []);
      const failed = Bun.spawn([...competing.argv], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      expect(await failed.exited).not.toBe(0);
      await expect(runSystemdHelper({ kind: 'inspect', launch: competing.identity }))
        .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
      const mismatch = { ...first.identity, invocationId: first.identity.invocationId === 'd'.repeat(32) ? 'e'.repeat(32) : 'd'.repeat(32) };
      await expect(runSystemdHelper({ kind: 'stop', identity: mismatch }))
        .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
      expect(first.waiter.exitCode).toBeNull();
    } finally { await first.dispose(); }

    const replacement = await start(nodeId);
    try {
      expect(replacement.identity.unitName).toBe(first.identity.unitName);
      expect(replacement.identity.invocationId).not.toBe(first.identity.invocationId);
      await expect(runSystemdHelper({ kind: 'stop', identity: first.identity }))
        .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
      expect(replacement.waiter.exitCode).toBeNull();
    } finally { await replacement.dispose(); }
  }, 45_000);

  test('SIGKILL of MainPID also retires its setsid child before a fresh incarnation', async () => {
    const fixture = await start(`synthetic-${randomUUID()}`);
    try {
      fixture.waiter.stdin.write('crash\n');
      await fixture.waiter.stdin.flush();
      expect(await fixture.waiter.exited).not.toBe(0);
      expect(existsSync(`/sys/fs/cgroup${fixture.identity.controlGroup}`)).toBe(false);
    } finally { await fixture.dispose(); }
  }, 30_000);
});
