import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSystemdHelper } from '../server/execution-node/systemd/helper-process.js';
import { isControlGroup, SYSTEMD_HELPER_FLAG } from '../server/execution-node/systemd/contracts.js';

export async function smokeSystemdHelper(command, { probeManager = probeUserManager } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-private-helper-smoke-'));
  try {
    const environment = {
      TMPDIR: directory, TEMP: directory, TMP: directory,
      GARCON_CONFIG_DIR: join(directory, 'controller-config'), GARCON_PORT: 'invalid',
    };
    let failure;
    try {
      await runSystemdHelper({ kind: 'inspect', launch: {
        unitName: `garcon-exec-${'a'.repeat(64)}.service`, launchId: 'b'.repeat(32),
      } }, {
        spawn: helperSpawner(command, {
          ...environment, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(directory, 'absent-bus')}`,
        }),
      });
    } catch (error) { failure = error; }
    if (failure?.code !== 'NODE_CONTAINMENT_UNAVAILABLE') throw new Error('Private helper did not reach containment validation', { cause: failure });
    const managerControlGroup = probeManager();
    if (managerControlGroup !== null) {
      const unitName = `garcon-exec-${randomBytes(32).toString('hex')}.service`;
      await runSystemdHelper({ kind: 'stop', identity: {
        unitName, launchId: randomBytes(16).toString('hex'), invocationId: randomBytes(16).toString('hex'),
        controlGroup: `${managerControlGroup}/${unitName}`, mainPid: process.pid,
      } }, { spawn: helperSpawner(command, {
        ...environment, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      }) });
    }
    if ((await readdir(directory)).length !== 0) throw new Error('Private helper initialized controller or provider storage');
    console.log(managerControlGroup === null
      ? 'Private helper native probe skipped (requires Linux, a healthy user manager, and unified cgroup v2)'
      : 'Private helper native probe passed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function helperSpawner(command, environment) {
  return (request) => {
    const child = Bun.spawn(command, {
      stdin: new TextEncoder().encode(request), stdout: 'pipe', stderr: 'ignore', env: environment,
    });
    return { output: child.stdout, exited: child.exited, kill: () => child.kill('SIGKILL') };
  };
}

function probeUserManager() {
  if (process.platform !== 'linux') return null;
  const options = { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000, maxBuffer: 4_096, encoding: 'utf8' };
  if (spawnSync('systemctl', ['--user', 'is-system-running'], options).status !== 0) return null;
  const result = spawnSync('systemctl', ['--user', 'show', '--property=ControlGroup', '--value'], options);
  if (result.status !== 0 || !isControlGroup(result.stdout.trim())) return null;
  try {
    if (statfsSync('/sys/fs/cgroup').type !== 0x63677270) return null;
  } catch { return null; }
  return result.stdout.trim();
}

if (import.meta.main) {
  const executable = process.argv[2];
  if (!executable) throw new Error('Expected the compiled Garcon executable path');
  await smokeSystemdHelper([executable, SYSTEMD_HELPER_FLAG]);
  console.log('Private compiled helper smoke passed');
}
