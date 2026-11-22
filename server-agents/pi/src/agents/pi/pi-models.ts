import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SharedModelOption } from '@garcon/common/models';
import { errorMessage, hasNodeErrorCode } from '@garcon/server-agent-common/lib/errors';
import { waitUnlessAborted } from '@garcon/server-agent-common/shared/shared-probe';
import type { PiConfig } from '../../config.js';
import { buildPiCliEnv } from './pi-cli.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const FAILURE_COOLDOWN_MS = 15_000;
const TABLE_HEADER = /^provider +model +context +max-out +thinking +images$/;
const EMPTY_BANNER = 'No models available. Use /login ';

class InvalidPiModelListing extends Error {}

export class PiModelDiscoveryUnavailableError extends Error {
  readonly code = 'PI_MODEL_DISCOVERY_UNAVAILABLE';
  readonly staleModels: SharedModelOption[];

  constructor(message: string, staleModels: SharedModelOption[]) {
    super(message);
    this.name = 'PiModelDiscoveryUnavailableError';
    this.staleModels = staleModels;
  }
}

// The metadata command works before a model is selected and reports config errors even on exit 0.
// https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/cli/list-models.ts#L29-L115
export function parsePiModelListing(stdout: string, stderr: string): SharedModelOption[] {
  const lines = stdout.trimEnd().split(/\r?\n/);
  // Extensions and migrations can write startup notices before the listing.
  const start = lines.findIndex(line => TABLE_HEADER.test(line) || line.startsWith(EMPTY_BANNER));
  const header = lines[start];
  const rows = lines.slice(start + 1);
  if (header?.startsWith(EMPTY_BANNER) && rows.length === 2
    && rows[0]?.trimEnd().endsWith('providers.md') && rows[1]?.trimEnd().endsWith('models.md')) {
    if (stderr.trim()) throw new Error('Pi reported discovery errors. Check pi --list-models on this executor.');
    return [];
  }
  if (!header || !TABLE_HEADER.test(header) || !rows.length) {
    throw new InvalidPiModelListing('Unexpected Pi --list-models output. Check the installed Pi CLI version.');
  }
  const modelStart = header.indexOf('model');
  const contextStart = header.indexOf('context');
  const imagesStart = header.indexOf('images');
  return rows.map((row) => {
    const provider = row.slice(0, modelStart).trim();
    const id = row.slice(modelStart, contextStart).trim();
    const images = row.slice(imagesStart).trim();
    if (!provider || !id || (images !== 'yes' && images !== 'no')) {
      throw new InvalidPiModelListing('Malformed row in Pi --list-models output.');
    }
    const shortId = id.split('/').filter(Boolean).at(-1) ?? id;
    return { value: `${provider}/${id}`, label: `${provider}: ${shortId}`, supportsImages: images === 'yes' };
  });
}

export async function getPiAvailableModels(
  binary: string,
  signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
): Promise<SharedModelOption[]> {
  signal.throwIfAborted();
  const env = buildPiCliEnv({ NO_COLOR: '1' });
  delete env.FORCE_COLOR;
  const proc = Bun.spawn([binary, '--list-models'], {
    env,
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    detached: process.platform !== 'win32', maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL',
  });
  // An extension subprocess can keep a pipe open after Pi exits. The deadline also cancels both reads.
  const read = (stream: ReadableStream<Uint8Array>) =>
    new Response(stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal })).text();
  try {
    const [stdout, stderr, code] = await waitUnlessAborted(
      Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]), signal,
    );
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`Pi model discovery failed (exit ${code}). Check pi --list-models on this executor.`);
    return parsePiModelListing(stdout, stderr);
  } finally {
    if (signal.aborted) await stopDiscoveryProcess(proc);
  }
}

async function stopDiscoveryProcess(proc: Bun.Subprocess): Promise<void> {
  try {
    if (process.platform !== 'win32') {
      // The group still identifies a wrapper's children after the wrapper exits.
      process.kill(-proc.pid, 'SIGKILL');
    } else if (proc.exitCode === null) {
      const taskkill = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      await Bun.spawn([taskkill, '/T', '/F', '/PID', String(proc.pid)], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 2_000,
      }).exited;
    }
  } catch (error) {
    if (!hasNodeErrorCode(error, 'ESRCH') && !hasNodeErrorCode(error, 'ENOENT')) throw error;
  } finally {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await proc.exited;
  }
}

export class PiModelCatalogService {
  #cachedModels: SharedModelOption[] | null = null;
  #cachedAt = 0;
  #failure: { error: PiModelDiscoveryUnavailableError; retryAt: number } | null = null;
  #inflight: Promise<SharedModelOption[]> | null = null;
  #lifetime = new AbortController();

  constructor(
    private readonly config: PiConfig,
    private readonly discover: (signal: AbortSignal) => Promise<SharedModelOption[]> = (signal) => getPiAvailableModels(config.binary(), signal),
  ) {}

  async getModelsStrict(signal?: AbortSignal): Promise<SharedModelOption[]> {
    signal?.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    const now = Date.now();
    if (this.#cachedModels && now - this.#cachedAt < MODEL_CACHE_TTL_MS) {
      return this.#cachedModels;
    }
    if (this.#failure && now < this.#failure.retryAt) throw this.#failure.error;
    this.#inflight ??= this.#discoverWithRetry(this.#lifetime.signal).finally(() => {
      this.#inflight = null;
    });
    return waitUnlessAborted(this.#inflight, signal);
  }

  async getModels(signal?: AbortSignal): Promise<SharedModelOption[]> {
    try {
      return await this.getModelsStrict(signal);
    } catch (error) {
      signal?.throwIfAborted();
      this.#lifetime.signal.throwIfAborted();
      if (isPiModelDiscoveryUnavailableError(error)) return error.staleModels;
      return this.#staleModels();
    }
  }

  start(): void {
    if (this.#lifetime.signal.aborted) this.#lifetime = new AbortController();
  }

  async stop(): Promise<void> {
    this.#lifetime.abort();
    await this.#inflight?.catch(() => undefined);
    this.#cachedModels = null;
    this.#failure = null;
  }

  #staleModels(): SharedModelOption[] {
    return this.#cachedModels?.length ? this.#cachedModels : [];
  }

  async #discoverWithRetry(lifetime: AbortSignal): Promise<SharedModelOption[]> {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
    const attemptDelays = this.config.isTestEnvironment() ? [0, 0, 0] : [0, 75, 250];
    let lastError: unknown;
    for (const retryDelay of attemptDelays) {
      try {
        if (retryDelay > 0) await delay(retryDelay, undefined, { signal });
        signal.throwIfAborted();
        const models = await this.discover(signal);
        signal.throwIfAborted();
        this.#cachedAt = Date.now();
        this.#cachedModels = models;
        this.#failure = null;
        return models;
      } catch (error) {
        lifetime.throwIfAborted();
        lastError = signal.aborted ? signal.reason : error;
        if (hasNodeErrorCode(lastError, 'ENOENT') || lastError instanceof InvalidPiModelListing
          || (lastError instanceof Error && lastError.name === 'TimeoutError')) break;
      }
    }
    const failure = new PiModelDiscoveryUnavailableError(errorMessage(lastError), this.#staleModels());
    // A new installation must be visible on the very next request.
    if (!hasNodeErrorCode(lastError, 'ENOENT')) {
      this.#failure = { error: failure, retryAt: Date.now() + FAILURE_COOLDOWN_MS };
    }
    throw failure;
  }
}

export function isPiModelDiscoveryUnavailableError(error: unknown): error is PiModelDiscoveryUnavailableError {
  return error instanceof PiModelDiscoveryUnavailableError
    || Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'PI_MODEL_DISCOVERY_UNAVAILABLE');
}
