import { readTextStreamWithLimit } from '../../lib/bounded-text-stream.js';
import { serverSelfCommand } from '../../lib/self-command.js';
import { validateSystemdHelperWorkingDirectory } from './helper-cwd.js';
import {
  parseSystemdHelperReply, parseSystemdHelperRequest, SYSTEMD_HELPER_FLAG, SYSTEMD_HELPER_MAX_BYTES,
  SYSTEMD_HELPER_TIMEOUT_MS, SystemdContainmentError, type SystemdHelperReply, type SystemdHelperRequest,
} from './contracts.js';

export interface SystemdHelperProcess {
  readonly output: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface SystemdHelperOptions {
  readonly workingDirectory?: string;
  readonly spawn?: (request: string) => SystemdHelperProcess;
  readonly scheduleTimeout?: (callback: () => void, delay: number) => { cancel(): void };
}

/**
 * Accepts a result only after helper exit. The deadline bounds kill initiation, not reaping;
 * unconfirmed child exit leaves the promise pending so callers cannot release the cleanup fence.
 */
export async function runSystemdHelper(
  input: SystemdHelperRequest,
  options: SystemdHelperOptions = {},
): Promise<Exclude<SystemdHelperReply, { kind: 'failed' }>> {
  const request = parseSystemdHelperRequest(input);
  if (!request) throw invalid();
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > SYSTEMD_HELPER_MAX_BYTES) throw invalid();
  let child: SystemdHelperProcess;
  try {
    child = options.spawn ? options.spawn(serialized) : spawnHelper(serialized, options.workingDirectory);
  } catch {
    throw new SystemdContainmentError('NODE_CONTAINMENT_UNAVAILABLE');
  }
  let exited = false;
  const exitProof = Promise.withResolvers<number>();
  const observedExit = child.exited.then((code) => { exited = true; exitProof.resolve(code); return code; },
    () => { throw new SystemdContainmentError('NODE_CLEANUP_FAILED'); });
  const deadline = Promise.withResolvers<never>();
  const timer = (options.scheduleTimeout ?? scheduleTimeout)(() => {
    deadline.reject(new SystemdContainmentError('NODE_CLEANUP_TIMEOUT'));
  }, SYSTEMD_HELPER_TIMEOUT_MS);
  try {
    const [output, code] = await Promise.race([
      Promise.all([readTextStreamWithLimit(child.output, SYSTEMD_HELPER_MAX_BYTES, invalid), observedExit]),
      deadline.promise,
    ]);
    if (code !== 0) throw new SystemdContainmentError('NODE_CLEANUP_FAILED');
    const reply = parseSystemdHelperReply(JSON.parse(output));
    if (!reply) throw invalid();
    if (reply.kind === 'failed') throw new SystemdContainmentError(reply.code);
    if (request.kind === 'inspect') {
      if (reply.kind !== 'ready' || reply.identity.unitName !== request.launch.unitName
        || reply.identity.launchId !== request.launch.launchId) throw invalid();
    } else if (reply.kind !== (request.kind === 'stop' ? 'stopped' : 'retired-inert')) throw invalid();
    return reply;
  } catch (error) {
    if (!exited) {
      try { child.kill(); } catch { /* A failed termination request cannot establish exit. */ }
      await exitProof.promise;
    }
    throw error instanceof SystemdContainmentError ? error : invalid();
  } finally {
    timer.cancel();
  }
}

export function systemdHelperCommand(): string[] {
  const command = serverSelfCommand([SYSTEMD_HELPER_FLAG]);
  return Reflect.get(globalThis, Symbol.for('garcon.compiled-mode')) === true
    ? command : [command[0], '--no-env-file', '--config=/dev/null', ...command.slice(1)];
}

export const SYSTEMD_HELPER_BUN_OPTIONS = '--config=/dev/null';

function spawnHelper(serialized: string, directory: string | undefined): SystemdHelperProcess {
  validateSystemdHelperWorkingDirectory(directory);
  const child = Bun.spawn(systemdHelperCommand(), {
    cwd: directory,
    stdin: new TextEncoder().encode(serialized), stdout: 'pipe', stderr: 'ignore',
    env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      BUN_OPTIONS: SYSTEMD_HELPER_BUN_OPTIONS },
  });
  return { output: child.stdout, exited: child.exited, kill: () => child.kill('SIGKILL') };
}

function scheduleTimeout(callback: () => void, delay: number): { cancel(): void } {
  const timer = setTimeout(callback, delay);
  return { cancel: () => clearTimeout(timer) };
}

function invalid(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_MISMATCH'); }
