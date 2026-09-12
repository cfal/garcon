import path from 'node:path';
import { NodeSessionMarkerFile } from '../../server/execution-node/systemd/session-marker.js';
import { runSystemdHelper } from '../../server/execution-node/systemd/helper-process.js';

const [root, mode, executable] = process.argv.slice(2);
if (!root || !['watchdog', 'orphan', 'no-connect'].includes(mode!)) throw new Error('Invalid synthetic helper parent arguments');
if (mode === 'no-connect') {
  const child = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', '-e', 'setInterval(() => {}, 1_000);'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  const startTicks = (await Bun.file(`/proc/${child.pid}/stat`).text()).split(') ')[1]!.split(' ')[19];
  await Bun.write(path.join(root, 'unconnected-helper.json'), JSON.stringify({ pid: child.pid, startTicks }));
  console.log(JSON.stringify({ parentPid: process.pid, workingDirectory: root }));
  await child.exited;
  process.exit(0);
}
if (executable) {
  Object.defineProperty(process, 'execPath', { value: executable });
  Object.defineProperty(globalThis, Symbol.for('garcon.compiled-mode'), { value: true });
}
process.chdir(path.join(root, 'hostile'));
process.env.HOME = path.join(root, 'hostile-home');
process.env.XDG_CONFIG_HOME = process.env.HOME;
process.env.BUN_OPTIONS = `--preload=${path.join(root, 'hostile/preload.ts')}`;
process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(root, 'bus')}`;
const marker = await NodeSessionMarkerFile.acquire({ runtimeDirectory: path.join(root, 'runtime'), nodeId: 'synthetic-helper-node',
  controllerId: 'synthetic-controller', onCompromised() { throw new Error('Synthetic helper namespace compromised'); } });
console.log(JSON.stringify({ parentPid: process.pid, workingDirectory: marker.helperWorkingDirectory }));
let expire: (() => void) | undefined;
let timerCancelled = false;
const result = runSystemdHelper({ kind: 'inspect', launch: { unitName: `garcon-exec-${'a'.repeat(64)}.service`, launchId: 'b'.repeat(32) } }, {
  workingDirectory: marker.helperWorkingDirectory,
  ...(mode === 'watchdog' ? { scheduleTimeout(callback: () => void) { expire = callback; return { cancel() { timerCancelled = true; } }; } } : {}),
}).then((reply) => ({ reply }), (error: unknown) => ({ code: error instanceof Error && 'code' in error ? error.code : 'unexpected' }));
try {
  if (mode === 'watchdog') {
    if (await Bun.stdin.text() !== 'expire\n' || !expire) throw new Error('Synthetic watchdog was not armed');
    expire();
  }
  console.log(JSON.stringify({ ...await result, timerCancelled }));
} finally { await marker.release(); }
