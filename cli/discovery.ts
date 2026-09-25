import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import { cliRuntimeFile, type RuntimeKind, type RuntimeSelection } from '@garcon/common/cli-runtime-paths';
import {
  ServerRuntimeContractError,
  parseCliRuntimeDescriptor,
  parseCliContext,
  parseServerRuntimeProbe,
  runtimeProofPayload,
  type CliRuntimeDescriptor,
} from '@garcon/common/server-runtime';
import { CliError } from './errors.js';

const RUNTIME_PROBE_TIMEOUT_MS = 5_000;

export interface RuntimeConnection {
  baseUrl: string;
  instanceId: string;
  endpointInstanceId: string;
  defaultNodeId: string;
  workspaceName: string | null;
  localCapability: string;
  workspaceDir: string | null;
}

export interface RuntimeDiscoveryOptions {
  configDir: string;
  runtime?: RuntimeSelection;
  serverUrl?: string;
  signal?: AbortSignal;
}

export interface DiscoveredRuntime extends RuntimeConnection {
  selector: { runtime: RuntimeKind };
}

export interface RuntimeDiscoveryDependencies {
  fetch?: typeof fetch;
  warn?: (message: string) => void;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return net.isIP(normalized) === 4 && normalized.startsWith('127.');
}

export function parseLoopbackServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CliError('discovery', 'server URL must be an absolute URL', 3, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('discovery', 'server URL must use HTTP or HTTPS', 3);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new CliError('discovery', 'server URL must use a loopback host', 3);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError('discovery', 'server URL must not include credentials, query, or fragment', 3);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new CliError('discovery', 'server URL must not include a path', 3);
  }
  return url.toString().replace(/\/$/, '');
}

async function readRuntimeDescriptor(descriptorPath: string, runtime: RuntimeKind): Promise<CliRuntimeDescriptor> {
  let handle: fsPromises.FileHandle | undefined;
  const invalid = (reason: string) => new CliError('discovery', `runtime file ${descriptorPath}: ${reason}`, 3);
  try {
    if (process.platform === 'win32') {
      const linkStat = await fsPromises.lstat(descriptorPath);
      if (linkStat.isSymbolicLink()) throw invalid('must not be a symbolic link');
    }
    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    handle = await fsPromises.open(descriptorPath, fs.constants.O_RDONLY | noFollow);
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) throw invalid('must be a regular file');
    if (descriptorStat.size > 16_384) throw invalid('exceeds the 16 KiB limit');
    if (process.platform !== 'win32' && (descriptorStat.mode & 0o077) !== 0) {
      throw invalid('must be readable only by its owner');
    }
    if (
      process.platform !== 'win32'
      && typeof process.getuid === 'function'
      && descriptorStat.uid !== process.getuid()
    ) {
      throw invalid('must be owned by the current user');
    }
    const raw = JSON.parse(await handle.readFile('utf8')) as unknown;
    const descriptor = parseCliRuntimeDescriptor(raw);
    if (('kind' in descriptor ? 'execution-node' : 'controller') !== runtime) {
      throw invalid(`does not describe a ${runtime} runtime`);
    }
    return descriptor;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw invalid('must not be a symbolic link');
    if (
      error instanceof ServerRuntimeContractError
      && error.message === 'unsupported runtime schema version'
    ) {
      throw new CliError(
        'discovery',
        `runtime file ${descriptorPath}: schema is unsupported; upgrade Garcon and garcon-cli together`,
        3,
        { cause: error },
      );
    }
    throw new CliError(
      'discovery',
      `cannot read a valid runtime file at ${descriptorPath}`,
      3,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function probeRuntime(
  baseUrl: string,
  expectedInstanceId: string,
  localCapability: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const timeoutSignal = AbortSignal.timeout(RUNTIME_PROBE_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const challenge = crypto.randomBytes(32).toString('base64url');
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/api/v1/runtime?challenge=${encodeURIComponent(challenge)}`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CliError('runtime verification', 'runtime probe could not reach the server', 3, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new CliError(
      'runtime verification',
      `runtime probe failed with HTTP ${response.status}`,
      3,
    );
  }
  try {
    const probe = parseServerRuntimeProbe(await response.json());
    if (probe.instanceId !== expectedInstanceId) return false;
    const expectedProof = crypto.createHmac('sha256', localCapability)
      .update(runtimeProofPayload(probe.instanceId, challenge))
      .digest();
    const actualProof = Buffer.from(probe.proof, 'base64url');
    return actualProof.length === expectedProof.length
      && crypto.timingSafeEqual(actualProof, expectedProof);
  } catch (error) {
    throw new CliError('runtime verification', 'runtime probe returned an invalid response', 3, {
      cause: error,
    });
  }
}

export async function discoverRuntime(
  options: RuntimeDiscoveryOptions,
  dependencies: RuntimeDiscoveryDependencies = {},
): Promise<DiscoveredRuntime> {
  options.signal?.throwIfAborted();
  const candidate = await selectRuntime(options, dependencies);
  try {
    return await connectRuntime(candidate, options, dependencies);
  } catch (error) {
    options.signal?.throwIfAborted();
    const detail = error instanceof CliError ? error.message : 'could not retrieve a valid CLI context';
    const guidance = candidate.alternative
      ? `Use --runtime ${candidate.alternative} only if you intend to switch roles`
      : 'Check that the selected runtime is running and available; restart it if it has exited';
    throw new CliError(error instanceof CliError ? error.phase : 'discovery',
      `${candidate.runtime} runtime at ${candidate.descriptorPath}: ${detail}. No fallback was attempted. ${guidance}`,
      3, { cause: error });
  }
}

async function connectRuntime(candidate: RuntimeCandidate, options: RuntimeDiscoveryOptions, dependencies: RuntimeDiscoveryDependencies): Promise<DiscoveredRuntime> {
  const endpoint = await verifyEndpoint(candidate, options, dependencies);
  const { descriptor, baseUrl } = endpoint;
  assertServerUrl(options.serverUrl, baseUrl);
  const fetchFn = dependencies.fetch ?? fetch;
  const response = await fetchFn(`${baseUrl}/api/v1/cli/context`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${descriptor.localCapability}` },
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(RUNTIME_PROBE_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) throw new CliError('discovery', `CLI context unavailable (HTTP ${response.status})`, 3);
  const context = parseCliContext(await response.json());
  if ('workspaceDir' in descriptor && context.serverInstanceId !== descriptor.instanceId) {
    throw new CliError('discovery', 'controller changed during discovery; start a new CLI invocation', 3);
  }
  return {
    baseUrl,
    instanceId: context.serverInstanceId,
    endpointInstanceId: descriptor.instanceId,
    defaultNodeId: context.defaultNodeId,
    workspaceName: context.workspaceName,
    localCapability: descriptor.localCapability,
    workspaceDir: 'workspaceDir' in descriptor ? descriptor.workspaceDir : null,
    selector: { runtime: candidate.runtime },
  };
}

interface RuntimeCandidate {
  descriptorPath: string;
  runtime: RuntimeKind;
  descriptor: CliRuntimeDescriptor;
  alternative?: RuntimeKind;
}

interface VerifiedEndpoint {
  descriptor: CliRuntimeDescriptor;
  baseUrl: string;
}

function assertServerUrl(serverUrl: string | undefined, baseUrl: string): void {
  if (serverUrl !== undefined && parseLoopbackServerUrl(serverUrl) !== baseUrl) {
    throw new CliError('runtime verification', '--server must exactly match the URL in the selected runtime descriptor', 3);
  }
}

async function verifyEndpoint(
  candidate: RuntimeCandidate,
  options: Pick<RuntimeDiscoveryOptions, 'serverUrl' | 'signal'>,
  dependencies: RuntimeDiscoveryDependencies,
): Promise<VerifiedEndpoint> {
  const fetchFn = dependencies.fetch ?? fetch;
  options.signal?.throwIfAborted();
  const descriptor = candidate.descriptor;
  const baseUrl = parseLoopbackServerUrl(descriptor.baseUrl);
  assertServerUrl(options.serverUrl, baseUrl);
  const verified = await probeRuntime(baseUrl, descriptor.instanceId, descriptor.localCapability, fetchFn, options.signal);
  if (verified) return { descriptor, baseUrl };

  throw new CliError(
    'runtime verification',
    `the selected ${candidate.runtime} does not match ${candidate.descriptorPath}; restart that runtime or select another role explicitly`,
    3,
  );
}

async function selectRuntime(options: RuntimeDiscoveryOptions, dependencies: RuntimeDiscoveryDependencies): Promise<RuntimeCandidate> {
  const selection = options.runtime ?? 'auto';
  const kinds: RuntimeKind[] = selection === 'auto' ? ['controller', 'execution-node'] : [selection];
  const candidates: RuntimeCandidate[] = [];
  const errors: unknown[] = [];
  for (const runtime of kinds) {
    options.signal?.throwIfAborted();
    const descriptorPath = cliRuntimeFile(options.configDir, runtime);
    try {
      const descriptor = await readRuntimeDescriptor(descriptorPath, runtime);
      parseLoopbackServerUrl(descriptor.baseUrl);
      candidates.push({ runtime, descriptorPath, descriptor });
    } catch (error) {
      if (error instanceof CliError && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
      errors.push(error);
    }
  }
  if (candidates.length === 0 && errors.length === 0) {
    throw new CliError('discovery', `no ${selection === 'auto' ? 'Garcon' : selection} runtime file under ${options.configDir}; start that runtime first`, 3);
  }
  const warn = dependencies.warn ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  if (errors.length > 0) {
    if (candidates.length + errors.length > 1) warn('warning: both runtime files exist; automatic selection failed. Use --runtime controller or --runtime execution-node to select explicitly.');
    throw errors[0];
  }
  const chosen = candidates.reduce((selected, candidate) => Date.parse(candidate.descriptor.startedAt) > Date.parse(selected.descriptor.startedAt) ? candidate : selected);
  if (candidates.length > 1) {
    warn(`warning: both runtime files exist; selected ${chosen.runtime} (startedAt ${new Date(chosen.descriptor.startedAt).toISOString()}). Use --runtime controller or --runtime execution-node to select explicitly.`);
  }
  const alternative = candidates.find((candidate) => candidate !== chosen)?.runtime;
  return { ...chosen, ...(alternative ? { alternative } : {}) };
}
