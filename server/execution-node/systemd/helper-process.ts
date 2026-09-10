import { fileURLToPath } from 'node:url';
import { readTextStreamWithLimit } from '../../lib/bounded-text-stream.js';
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
    child = (options.spawn ?? spawnHelper)(serialized);
  } catch {
    throw new SystemdContainmentError('NODE_CONTAINMENT_UNAVAILABLE');
  }
  let exited = false;
  const reaped = child.exited.then((code) => { exited = true; return code; });
  const deadline = Promise.withResolvers<never>();
  const timer = (options.scheduleTimeout ?? scheduleTimeout)(() => {
    deadline.reject(new SystemdContainmentError('NODE_CLEANUP_TIMEOUT'));
  }, SYSTEMD_HELPER_TIMEOUT_MS);
  try {
    const [output, code] = await Promise.race([
      Promise.all([readTextStreamWithLimit(child.output, SYSTEMD_HELPER_MAX_BYTES, invalid), reaped]),
      deadline.promise,
    ]);
    if (code !== 0) throw new SystemdContainmentError('NODE_CLEANUP_FAILED');
    const reply = parseSystemdHelperReply(JSON.parse(output));
    if (!reply) throw invalid();
    if (reply.kind === 'failed') throw new SystemdContainmentError(reply.code);
    if (request.kind === 'inspect') {
      if (reply.kind !== 'ready' || reply.identity.unitName !== request.launch.unitName
        || reply.identity.launchId !== request.launch.launchId) throw invalid();
    } else if (reply.kind !== 'stopped') throw invalid();
    return reply;
  } catch (error) {
    if (!exited) {
      try { child.kill(); } finally { await reaped; }
    }
    throw error instanceof SystemdContainmentError ? error : invalid();
  } finally {
    timer.cancel();
  }
}

export function systemdHelperCommand(): string[] {
  return Reflect.get(globalThis, Symbol.for('garcon.compiled-mode')) === true
    ? [process.execPath, SYSTEMD_HELPER_FLAG]
    : [process.execPath, fileURLToPath(new URL('../../main.ts', import.meta.url)), SYSTEMD_HELPER_FLAG];
}

function spawnHelper(serialized: string): SystemdHelperProcess {
  const child = Bun.spawn(systemdHelperCommand(), {
    stdin: new TextEncoder().encode(serialized), stdout: 'pipe', stderr: 'ignore',
    env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS },
  });
  return { output: child.stdout, exited: child.exited, kill: () => child.kill('SIGKILL') };
}

function scheduleTimeout(callback: () => void, delay: number): { cancel(): void } {
  const timer = setTimeout(callback, delay);
  return { cancel: () => clearTimeout(timer) };
}

function invalid(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_MISMATCH'); }
