import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { BoundedLog } from '../support/bounded-log.js';
import { isolatedEnvironment } from '../support/garcon-process.js';
import { withTimeout } from '../support/deferred.js';
import { OwnedBrowserProcesses } from './processes.js';
import { readTrace, requireCoverage, type TraceSummary } from './trace.js';

export const BOMBADIL_VERSION = '0.7.10';
export const BOMBADIL_REVISION = '832faf4d953e2c56d1d901aca1bb2c3c3170221d';
const ROOT = resolve(import.meta.dir, '../..');
const VIEWPORT = { width: 1440, height: 900 };
let interruptedSignal: NodeJS.Signals | null = null;

export function assertBombadilNotInterrupted(): void {
  if (interruptedSignal) throw new Error(`Bombadil lane interrupted by ${interruptedSignal}; refusing another campaign`);
}

export interface RunOptions {
  origin: string;
  specification: string;
  privateDirectory: string;
  artifacts: string;
  seconds: number;
  instrument?: boolean;
  signal?: AbortSignal;
  deadlineMs?: number;
  redact?: string[];
  reproduce?: string;
  sources?: string[];
}

async function executableVersion(binary: string, env: Record<string, string>): Promise<string> {
  const child = Bun.spawn([binary, '--version'], { env, stdout: 'pipe', stderr: 'ignore' });
  try {
    const [version, code] = await withTimeout(Promise.all([new Response(child.stdout).text(), child.exited]),
      5_000, () => 'Executable version check timed out');
    if (code !== 0) throw new Error(`Executable version check exited ${code}`);
    return version.trim();
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

async function fileHash(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await readFile(path)).digest('hex');
}

export async function runBombadil(options: RunOptions): Promise<TraceSummary> {
  assertBombadilNotInterrupted();
  const startedAt = new Date().toISOString();
  if (process.platform !== 'linux') throw new Error('The Bombadil lane requires Linux process ownership checks');
  const binary = resolve(ROOT, `integration-tests/node_modules/@antithesishq/bombadil/binaries/bombadil-linux-${process.arch}`);
  const chrome = chromium.executablePath();
  const owned = new OwnedBrowserProcesses();
  const env = isolatedEnvironment(join(options.privateDirectory, 'home'), {
    ...owned.environment, CHROME: chrome, RUST_LOG: 'info', XDG_CACHE_HOME: join(options.privateDirectory, 'cache'),
  });
  // Chromium appends a singleton socket name; Linux limits the entire socket path to 108 bytes.
  if (Buffer.byteLength(env.TMPDIR) > 60) throw new Error('Chromium requires a shorter TMPDIR path');
  await mkdir(env.TMPDIR, { recursive: true });
  await mkdir(options.artifacts, { recursive: true });
  const bombadilVersion = await executableVersion(binary, env);
  if (bombadilVersion !== `bombadil ${BOMBADIL_VERSION}`) throw new Error(`Unexpected Bombadil version: ${bombadilVersion}`);
  const chromeVersion = await executableVersion(chrome, env);
  const command = [binary, 'browser', 'test', '--headless'];
  if (options.reproduce) {
    command.push('--reproduce', resolve(options.reproduce));
  } else {
    command.push('--exit-on-violation', '--time-limit', `${options.seconds}s`);
  }
  command.push(
    '--width', String(VIEWPORT.width), '--height', String(VIEWPORT.height),
    `--instrument-javascript=${options.instrument ? 'files,inline' : ''}`,
    '--output-path', join(options.artifacts, 'trace'),
  );
  if (process.env.BOMBADIL_NO_SANDBOX === '1') command.push('--no-sandbox');
  command.push(options.origin, options.specification);
  const logs = new BoundedLog<string>(1_000);
  let actionFailure = false;
  let canceled = false;
  let forcedCleanup = 0;
  let exitCode: number | null = null;
  let summary: TraceSummary | undefined;
  let failure: unknown;
  const redact = (text: string) => (options.redact ?? []).reduce((result, value) => result.replaceAll(value, '[REDACTED]'), text);
  const child = Bun.spawn(command, { cwd: join(ROOT, 'integration-tests'), env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let tail = '';
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      const combined = tail + text;
      if (combined.includes('failed to apply action')) actionFailure = true;
      tail = combined.slice(-8_192);
      logs.push(redact(text.slice(-8_192)));
    }
  };
  const outputDrained = Promise.all([drain(child.stdout), drain(child.stderr)]).catch(error => {
    failure = error;
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (canceled) return;
    canceled = true;
    child.kill('SIGINT');
    escalation = setTimeout(() => child.kill('SIGKILL'), 5_000);
  };
  const timer = setTimeout(cancel, options.deadlineMs ?? (options.seconds + 30) * 1_000);
  const interrupted = (signal: NodeJS.Signals) => {
    interruptedSignal = signal;
    process.exitCode = 1;
    cancel();
  };
  const onInterrupt = () => interrupted('SIGINT');
  const onTerminate = () => interrupted('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    exitCode = await child.exited;
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    options.signal?.removeEventListener('abort', cancel);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    try {
      forcedCleanup = await owned.cleanup();
    } catch (error) {
      failure = error;
    }
    try {
      await withTimeout(outputDrained, 5_000, () => 'Bombadil output pipes did not close');
    } catch (error) {
      failure = error;
    }
  }
  try {
    if (failure) throw failure;
    if (canceled) throw new Error('Bombadil canceled or exceeded the outer deadline');
    summary = await readTrace(join(options.artifacts, 'trace/trace.jsonl'));
    if (exitCode !== 0) throw new Error(`Bombadil exited ${exitCode}`);
    if (forcedCleanup) throw new Error(`Bombadil leaked ${forcedCleanup} owned processes`);
    if (actionFailure) throw new Error('Bombadil failed to apply action');
    requireCoverage(summary);
  } catch (error) {
    failure = error;
  }
  const revision = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' });
  const garconRevision = (await new Response(revision.stdout).text()).trim();
  await revision.exited;
  const manifest = {
    bombadilVersion: BOMBADIL_VERSION, bombadilRevision: BOMBADIL_REVISION, garconRevision,
    binaryHash: await fileHash(binary),
    startedAt, finishedAt: new Date().toISOString(),
    specificationHash: await fileHash(options.specification),
    specificationSources: Object.fromEntries(await Promise.all((options.sources ?? []).map(async path =>
      [basename(path), await fileHash(path)]))),
    chrome, chromeVersion, seconds: options.seconds, instrument: options.instrument ?? false,
    viewport: [VIEWPORT.width, VIEWPORT.height],
    reproduce: options.reproduce ?? null,
    noSandbox: process.env.BOMBADIL_NO_SANDBOX === '1', exitCode, canceled, forcedCleanup, actionFailure,
    summary: summary && { ...summary, observations: summary.observations.slice(-1) },
    failure: failure instanceof Error ? failure.message : failure,
  };
  await writeFile(join(options.artifacts, 'run.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(options.artifacts, 'output.log'), redact(logs.values().join('')));
  if (failure) throw new Error(`${failure instanceof Error ? failure.message : failure}\nBombadil artifacts: ${options.artifacts}`);
  return summary!;
}
