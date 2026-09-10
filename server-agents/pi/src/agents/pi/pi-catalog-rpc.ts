import { isAbsolute } from 'node:path';
import type { SharedModelOption } from '@garcon/common/models';
import { piModelToOption } from './pi-model-option.js';
import { terminatePiProcess, type PiProcessLifetime } from './pi-process-lifecycle.js';
import { PiRpcClient, PiRpcCommandError, PiRpcTransportError, type PiRpcProcess } from './pi-rpc-client.js';

const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const CATALOG_MAX_MODELS = 10_000;

export interface PiCatalogProcessFactory {
  start(request: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  }): PiRpcProcess & PiProcessLifetime;
}

const catalogProcesses: PiCatalogProcessFactory = {
  start: ({ command, cwd, environment, signal }) => Bun.spawn([...command], {
    cwd,
    env: { ...environment },
    signal,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  }),
};

/** Keeps scoped catalog discovery out of the controller's Pi SDK and extension runtime. */
export function createPiCatalogRpcDiscovery(options: {
  readonly binary: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly processes?: PiCatalogProcessFactory;
  readonly timeoutMs?: number;
}): (signal: AbortSignal) => Promise<SharedModelOption[]> {
  const { binary, cwd } = options;
  const environment: Readonly<Record<string, string | undefined>> = Object.freeze({
    ...options.environment, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
  });
  const processes = options.processes ?? catalogProcesses;
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  if (![binary, cwd, environment.HOME, environment.PI_CODING_AGENT_DIR].every(
    (path) => typeof path === 'string' && isAbsolute(path),
  )) throw new Error('Pi catalog requires an absolute binary, working directory, HOME and agent directory');
  if (!environment.PATH?.trim()) throw new Error('Pi catalog requires an explicit executable PATH');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Pi catalog timeout');
  const command = Object.freeze([binary, '--mode', 'rpc', '--no-session', '--no-tools']);

  return async (signal) => {
    signal.throwIfAborted();
    const lifetime = new AbortController();
    const launchSignal = AbortSignal.any([signal, lifetime.signal]);
    const timer = setTimeout(() => {
      lifetime.abort(new Error('Pi catalog discovery timed out'));
    }, timeoutMs);
    let process: (PiRpcProcess & PiProcessLifetime) | null = null;
    let client: PiRpcClient | null = null;
    let exitCode: number | null = null;
    let failure: { error: unknown } | null = null;
    const onAbort = () => client?.dispose('Pi catalog discovery cancelled');
    try {
      process = processes.start({ command, cwd, environment, signal: launchSignal });
      void process.exited.then((code) => { exitCode = code; }, () => {});
      launchSignal.throwIfAborted();
      client = new PiRpcClient(process, {
        onEvent() {},
        onMalformed: () => client?.dispose('Pi catalog returned malformed RPC output'),
        maxOutputBytes: CATALOG_OUTPUT_MAX_BYTES,
      });
      launchSignal.addEventListener('abort', onAbort, { once: true });
      const response = await client.send({ type: 'get_available_models' }, timeoutMs);
      launchSignal.throwIfAborted();
      const models = response.data?.models;
      if (response.command !== 'get_available_models' || !Array.isArray(models)
        || models.length > CATALOG_MAX_MODELS) {
        throw new Error('Pi catalog returned an invalid model list');
      }
      const mapped = models.map(piModelToOption).filter((model): model is SharedModelOption => model !== null);
      if (mapped.length === 0) throw new Error('Pi catalog returned no available models');
      return mapped;
    } catch (error) {
      let reason = launchSignal.aborted ? launchSignal.reason : error;
      if (!launchSignal.aborted && error instanceof PiRpcCommandError) {
        reason = new Error('Pi rejected catalog discovery; check the profile model and credential configuration');
      } else if (!launchSignal.aborted && error instanceof PiRpcTransportError && exitCode !== null && exitCode !== 0) {
        reason = new Error(`Pi catalog process exited with code ${exitCode}; check the executable PATH, profile and extensions`);
      }
      failure = { error: reason };
      throw reason;
    } finally {
      clearTimeout(timer);
      launchSignal.removeEventListener('abort', onAbort);
      client?.dispose('Pi catalog discovery complete');
      if (process) {
        try {
          await terminatePiProcess(process);
        } catch (cleanupError) {
          const primaryFailure = failure ?? (launchSignal.aborted ? { error: launchSignal.reason } : null);
          if (primaryFailure) throw new AggregateError([primaryFailure.error, cleanupError], 'Pi catalog discovery and cleanup failed');
          throw cleanupError;
        }
      }
      signal.throwIfAborted();
    }
  };
}
