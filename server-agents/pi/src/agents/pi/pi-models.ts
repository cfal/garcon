import { buildPiCliEnv } from './pi-cli.js';
import type { SharedModelOption } from '@garcon/common/models';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { PiConfig } from '../../config.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

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
  const [header, ...rows] = stdout.trimEnd().split(/\r?\n/);
  if (header?.startsWith('No models available. Use /login ') && rows.length === 2
    && rows[0]?.trimEnd().endsWith('providers.md') && rows[1]?.trimEnd().endsWith('models.md')) {
    if (stderr.trim()) throw new Error('Pi reported discovery errors. Check pi --list-models on this executor.');
    return [];
  }
  if (!header || !/^provider +model +context +max-out +thinking +images$/.test(header) || !rows.length) {
    throw new Error('Unexpected Pi --list-models output. Check the installed Pi CLI version.');
  }
  const modelStart = header.indexOf('model');
  const contextStart = header.indexOf('context');
  const imagesStart = header.indexOf('images');
  return rows.map((row) => {
    const provider = row.slice(0, modelStart).trim();
    const id = row.slice(modelStart, contextStart).trim();
    const images = row.slice(imagesStart).trim();
    if (!provider || !id || (images !== 'yes' && images !== 'no')) {
      throw new Error('Malformed row in Pi --list-models output.');
    }
    return { value: `${provider}/${id}`, label: `${provider}: ${id.split('/').at(-1) || id}`, supportsImages: images === 'yes' };
  });
}

export async function getPiAvailableModels(
  config: Pick<PiConfig, 'binary'>,
  timeoutMs = 20_000,
): Promise<SharedModelOption[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const env = buildPiCliEnv();
  delete env.FORCE_COLOR;
  const proc = Bun.spawn([config.binary(), '--list-models'], {
    env: { ...env, NO_COLOR: '1' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    signal, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL',
  });
  // An extension subprocess can keep a pipe open after Pi exits. The deadline also cancels both reads.
  const read = (stream: ReadableStream<Uint8Array>) =>
    new Response(stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal })).text();
  const [stdout, stderr, code] = await Promise.all([
    read(proc.stdout), read(proc.stderr), proc.exited,
  ]);
  signal.throwIfAborted();
  if (code !== 0) throw new Error(`Pi model discovery failed (exit ${code}). Check pi --list-models on this executor.`);
  return parsePiModelListing(stdout, stderr);
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export class PiModelCatalogService {
  #cachedModels: SharedModelOption[] | null = null;
  #cachedAt = 0;
  #lastKnownGoodModels: SharedModelOption[] | null = null;
  #inflight: Promise<SharedModelOption[]> | null = null;

  constructor(
    private readonly config: PiConfig,
    private readonly discover: () => Promise<SharedModelOption[]> = () => getPiAvailableModels(config),
  ) {}

  async getModelsStrict(): Promise<SharedModelOption[]> {
    const now = Date.now();
    if (this.#cachedModels && now - this.#cachedAt < MODEL_CACHE_TTL_MS) {
      return this.#cachedModels;
    }
    if (this.#inflight) return this.#inflight;

    this.#inflight = this.#discoverWithRetry().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async getModels(): Promise<SharedModelOption[]> {
    try {
      return await this.getModelsStrict();
    } catch (error) {
      if (isPiModelDiscoveryUnavailableError(error)) return error.staleModels;
      return this.#lastKnownGoodModels ?? [];
    }
  }

  clearForTests(): void {
    this.#cachedModels = null;
    this.#cachedAt = 0;
    this.#lastKnownGoodModels = null;
    this.#inflight = null;
  }

  expireForTests(): void {
    this.#cachedAt = 0;
  }

  #cache(models: SharedModelOption[]): SharedModelOption[] {
    this.#cachedModels = models;
    this.#cachedAt = Date.now();
    this.#lastKnownGoodModels = models.length > 0 ? models : null;
    return models;
  }

  async #discoverWithRetry(): Promise<SharedModelOption[]> {
    const retryDelays = this.config.isTestEnvironment() ? [0, 0] : [75, 250];
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        return this.#cache(await this.discover());
      } catch (error) {
        lastError = error;
        const retryDelay = retryDelays[attempt];
        if (retryDelay === undefined) break;
        await delay(retryDelay);
      }
    }
    throw new PiModelDiscoveryUnavailableError(
      errorMessage(lastError),
      this.#lastKnownGoodModels ?? [],
    );
  }
}

export function isPiModelDiscoveryUnavailableError(error: unknown): error is PiModelDiscoveryUnavailableError {
  return error instanceof PiModelDiscoveryUnavailableError
    || Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'PI_MODEL_DISCOVERY_UNAVAILABLE');
}
