import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandWorkingDirectory } from '@garcon/common/command-output';
import { parseCommandWorkingDirectory } from '@garcon/common/command-output';
import type { ShellFamily } from './catalog.js';
import { commandFooter, shellInvocation, POWERSHELL_ENTRY } from './source.js';

export const COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024;
export const OUTPUT_BATCH_BYTES = 32 * 1024;
const DRAIN_TIMEOUT_MS = 1500;
const KILL_GRACE_MS = 500;

export interface ShellProcessResult {
  exitCode: number | null;
  signal: string | null;
  cwd: CommandWorkingDirectory;
  interrupted: boolean;
  complete: boolean;
}

export interface ShellProcessOptions {
  family: ShellFamily;
  executable: string;
  source: string;
  cwd: string;
  temporaryRoot: string;
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  output(channel: 'stdout' | 'stderr', content: string): Promise<void>;
}

export async function executeShell(options: ShellProcessOptions): Promise<ShellProcessResult> {
  options.signal.throwIfAborted();
  const directory = await mkdtemp(join(options.temporaryRoot, 'command-'));
  let child: ChildProcessWithoutNullStreams | null = null;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let captureOpen = true;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* Process-group termination is best effort. */ }
  };
  const terminate = () => {
    signalGroup('SIGTERM');
    escalation ??= setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
  };
  try {
    const sourcePath = join(directory, options.family === 'pwsh' ? 'source.ps1' : 'source');
    const resultPath = join(directory, 'cwd');
    const entryPath = join(directory, 'entry.ps1');
    if (options.family === 'pwsh') await writeFile(entryPath, POWERSHELL_ENTRY, { mode: 0o600, flag: 'wx' });
    await writeFile(sourcePath, `${options.source}\n\n${commandFooter(options.family, resultPath)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(resultPath, '', { mode: 0o600, flag: 'wx' });
    options.signal.throwIfAborted();
    child = spawn(options.executable, shellInvocation(options.family, sourcePath, options.cwd, entryPath), {
      cwd: options.cwd, env: options.environment ?? process.env,
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let complete = true;
    let outputBytes = 0;
    let outputFailure: unknown;
    const consume = async (stream: NodeJS.ReadableStream, channel: 'stdout' | 'stderr') => {
      const decoder = new TextDecoder();
      try {
        for await (const bytes of stream) {
          if (!captureOpen) return;
          const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
          for (let offset = 0; offset < buffer.length; offset += OUTPUT_BATCH_BYTES) {
            if (!captureOpen) return;
            const part = buffer.subarray(offset, offset + OUTPUT_BATCH_BYTES);
            outputBytes += part.length;
            if (outputBytes > COMMAND_OUTPUT_LIMIT) { complete = false; terminate(); return; }
            const text = decoder.decode(part, { stream: true });
            if (text) await options.output(channel, text);
          }
        }
        const tail = decoder.decode();
        if (captureOpen && tail) await options.output(channel, tail);
      } catch (error) {
        if (!captureOpen) return;
        complete = false;
        outputFailure ??= error;
        terminate();
      }
    };
    const readers = Promise.all([consume(child.stdout, 'stdout'), consume(child.stderr, 'stderr')]);
    options.signal.addEventListener('abort', terminate, { once: true });
    if (options.signal.aborted) terminate();
    const ended = await exit;
    child.stdin.destroy();
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      readers.then(() => true),
      new Promise<false>(resolve => { drainTimer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS); }),
    ]);
    clearTimeout(drainTimer);
    if (!drained) {
      complete = false;
      captureOpen = false;
      signalGroup('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    }
    if (outputFailure) throw outputFailure;
    const cwd = await readWorkingDirectory(resultPath);
    return { exitCode: ended.code, signal: ended.signal, cwd, interrupted: options.signal.aborted, complete };
  } finally {
    captureOpen = false;
    options.signal.removeEventListener('abort', terminate);
    if (escalation) {
      // Escalation belongs to this invocation even if its parent shell exited first.
      signalGroup('SIGKILL');
      clearTimeout(escalation);
    }
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}

async function readWorkingDirectory(path: string): Promise<CommandWorkingDirectory> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_537) throw new Error('Invalid cwd report');
      const buffer = Buffer.alloc(65_538);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65_537) throw new Error('Invalid cwd report');
      const text = buffer.toString('utf8', 0, bytesRead);
      const parsed = parseCommandWorkingDirectory({ kind: 'reported', path: text.endsWith('\n') ? text.slice(0, -1) : text });
      if (parsed) return parsed;
    } finally { await file.close(); }
  } catch { /* A command can exit before the footer or replace its private report. */ }
  return { kind: 'unavailable', reason: 'The command did not report a valid filesystem directory.' };
}
