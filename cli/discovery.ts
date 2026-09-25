import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { cliGatewayRuntimeDirectory, executionNodeDataDirectory, isCliGatewayRuntimeFilename } from '@garcon/common/cli-runtime-paths';
import {
  SERVER_RUNTIME_FILENAME,
  ServerRuntimeContractError,
  parseCliRuntimeDescriptor,
  parseCliContext,
  parseServerRuntimeProbe,
  runtimeProofPayload,
  type CliRuntimeDescriptor,
} from '@garcon/common/server-runtime';
import { abortableDelay } from './abortable-delay.js';
import { CliError } from './errors.js';
import { connectionCommandPrefix } from './connection-options.js';
import type { CliConnectionOptions } from './args.js';

const RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const DESCRIPTOR_RECHECK_DELAY_MS = 50;

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
  workspace?: string;
  serverUrl?: string;
  runtimeFile?: string;
  expectedWorkspace?: string;
  signal?: AbortSignal;
}

export interface DiscoveredRuntime extends RuntimeConnection {
  selector: Pick<CliConnectionOptions, 'workspace' | 'runtimeFile'>;
}

export interface RuntimeDiscoveryDependencies {
  fetch?: typeof fetch;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
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

async function canonicalWorkspace(configDir: string, workspace: string): Promise<string> {
  try {
    const canonicalConfigDir = await fsPromises.realpath(configDir);
    const namedWorkspace = path.resolve(canonicalConfigDir, `workspace-${workspace}`);
    if (path.dirname(namedWorkspace) !== canonicalConfigDir) {
      throw new Error('workspace is not a direct child of the config directory');
    }
    const canonicalWorkspaceDir = await fsPromises.realpath(namedWorkspace);
    if (path.dirname(canonicalWorkspaceDir) !== canonicalConfigDir) {
      throw new Error('workspace directory must resolve to a direct child of the config directory');
    }
    return canonicalWorkspaceDir;
  } catch (error) {
    throw new CliError(
      'discovery',
      `named workspace "${workspace}" is unavailable below ${configDir}`,
      3,
      { cause: error },
    );
  }
}

async function readRuntimeDescriptor(descriptorPath: string, workspaceDir: string | null): Promise<CliRuntimeDescriptor> {
  let handle: fsPromises.FileHandle | undefined;
  try {
    if (process.platform === 'win32') {
      const linkStat = await fsPromises.lstat(descriptorPath);
      if (linkStat.isSymbolicLink()) throw new Error('runtime descriptor must not be a symbolic link');
    }
    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
    handle = await fsPromises.open(descriptorPath, fs.constants.O_RDONLY | noFollow);
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) throw new Error('runtime descriptor must be a regular file');
    if (descriptorStat.size > 16_384) throw new Error('runtime descriptor is too large');
    if (process.platform !== 'win32' && (descriptorStat.mode & 0o077) !== 0) {
      throw new Error('runtime descriptor must be readable only by its owner');
    }
    if (
      process.platform !== 'win32'
      && typeof process.getuid === 'function'
      && descriptorStat.uid !== process.getuid()
    ) {
      throw new Error('runtime descriptor must be owned by the current user');
    }
    const raw = JSON.parse(await handle.readFile('utf8')) as unknown;
    const descriptor = parseCliRuntimeDescriptor(raw);
    if (workspaceDir !== null && (!('workspaceDir' in descriptor) || descriptor.workspaceDir !== workspaceDir)) {
      throw new Error('runtime descriptor belongs to a different workspace');
    }
    return descriptor;
  } catch (error) {
    if (
      error instanceof ServerRuntimeContractError
      && error.message === 'unsupported runtime schema version'
    ) {
      throw new CliError(
        'discovery',
        'runtime descriptor schema is unsupported; upgrade Garcon and garcon-cli together',
        3,
        { cause: error },
      );
    }
    throw new CliError(
      'discovery',
      `cannot read a secure runtime descriptor at ${descriptorPath}`,
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
  let endpoint: VerifiedEndpoint;
  if (options.runtimeFile) {
    endpoint = await verifyEndpoint({ descriptorPath: options.runtimeFile, workspaceDir: null }, options, dependencies);
  } else if (options.workspace !== undefined) {
    const workspaceDir = await canonicalWorkspace(options.configDir, options.workspace);
    endpoint = await verifyEndpoint({ descriptorPath: path.join(workspaceDir, SERVER_RUNTIME_FILENAME),
      workspaceDir, workspace: options.workspace }, options, dependencies);
  } else {
    endpoint = await discoverEndpoint(options, dependencies);
  }
  const { candidate, descriptor, baseUrl } = endpoint;
  assertServerUrl(options.serverUrl, baseUrl);
  const fetchFn = dependencies.fetch ?? fetch;
  const response = await fetchFn(`${baseUrl}/api/v1/cli/context`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${descriptor.localCapability}` },
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(RUNTIME_PROBE_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) throw new CliError('discovery', `CLI context unavailable (HTTP ${response.status})`, 3);
  const context = parseCliContext(await response.json());
  if (options.expectedWorkspace !== undefined && options.expectedWorkspace !== context.workspaceName) {
    throw new CliError('discovery', '--workspace does not match the authenticated CLI context', 3);
  }
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
    workspaceDir: candidate.workspaceDir,
    selector: candidate.workspace === undefined
      ? { runtimeFile: candidate.descriptorPath }
      : { workspace: candidate.workspace },
  };
}

interface RuntimeCandidate {
  descriptorPath: string;
  workspaceDir: string | null;
  workspace?: string;
  gateway?: boolean;
}

interface VerifiedEndpoint {
  candidate: RuntimeCandidate;
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
  const wait = dependencies.delay ?? abortableDelay;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    options.signal?.throwIfAborted();
    const descriptor = await readRuntimeDescriptor(candidate.descriptorPath, candidate.workspaceDir);
    if (candidate.gateway && !('kind' in descriptor)) {
      throw new CliError('discovery', 'worker runtime descriptor must identify an execution-node gateway', 3);
    }
    const baseUrl = parseLoopbackServerUrl(descriptor.baseUrl);
    assertServerUrl(options.serverUrl, baseUrl);
    const verified = await probeRuntime(
      baseUrl,
      descriptor.instanceId,
      descriptor.localCapability,
      fetchFn,
      options.signal,
    );
    if (verified) return { candidate, descriptor, baseUrl };
    if (attempt === 0) await wait(DESCRIPTOR_RECHECK_DELAY_MS, options.signal);
  }

  throw new CliError(
    'runtime verification',
    'the selected server does not match the runtime descriptor',
    3,
  );
}

// Non-directory `workspace-*` entries such as backups surface as ENOTDIR and hold no endpoint.
const ABSENT_ENDPOINT_CODES = ['ENOENT', 'ENOTDIR', 'ECONNREFUSED', 'ConnectionRefused'];

interface CandidateOutcome {
  candidate: RuntimeCandidate;
  endpoint?: VerifiedEndpoint;
  error?: unknown;
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && typeof error.code === 'string' && codes.includes(error.code)) return true;
  return error instanceof Error && error.cause !== error && hasErrorCode(error.cause, codes);
}

async function directoryEntries(directory: string): Promise<string[]> {
  try { return (await fsPromises.readdir(directory)).sort(); }
  catch (error) {
    if (hasErrorCode(error, ['ENOENT', 'ENOTDIR'])) return [];
    throw new CliError('discovery', `cannot inspect runtime directory ${directory}`, 3, { cause: error });
  }
}

// Unresolvable workspace entries are kept as failed outcomes so they still block selection.
async function runtimeCandidates(configDir: string): Promise<CandidateOutcome[]> {
  const outcomes: CandidateOutcome[] = [];
  const seen = new Set<string>();
  for (const name of await directoryEntries(configDir)) {
    if (!name.startsWith('workspace-') || name === 'workspace-') continue;
    const workspace = name.slice('workspace-'.length);
    try {
      const workspaceDir = await canonicalWorkspace(configDir, workspace);
      if (seen.has(workspaceDir)) continue;
      seen.add(workspaceDir);
      outcomes.push({ candidate: { descriptorPath: path.join(workspaceDir, SERVER_RUNTIME_FILENAME), workspaceDir, workspace } });
    } catch (error) {
      if (hasErrorCode(error, ABSENT_ENDPOINT_CODES)) continue;
      outcomes.push({ candidate: { descriptorPath: path.join(configDir, name, SERVER_RUNTIME_FILENAME), workspaceDir: null, workspace }, error });
    }
  }
  const directory = cliGatewayRuntimeDirectory(executionNodeDataDirectory(configDir));
  for (const name of await directoryEntries(directory)) {
    if (isCliGatewayRuntimeFilename(name)) outcomes.push({ candidate: { descriptorPath: path.join(directory, name), workspaceDir: null, gateway: true } });
  }
  return outcomes;
}

async function discoverEndpoint(options: RuntimeDiscoveryOptions, dependencies: RuntimeDiscoveryDependencies): Promise<VerifiedEndpoint> {
  const outcomes: CandidateOutcome[] = [];
  for (const scanned of await runtimeCandidates(options.configDir)) {
    if (scanned.error !== undefined) {
      outcomes.push(scanned);
      continue;
    }
    try {
      outcomes.push({ candidate: scanned.candidate, endpoint: await verifyEndpoint(scanned.candidate, { signal: options.signal }, dependencies) });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!hasErrorCode(error, ABSENT_ENDPOINT_CODES)) outcomes.push({ candidate: scanned.candidate, error });
    }
  }
  if (outcomes.length === 1 && outcomes[0]!.endpoint) return outcomes[0]!.endpoint!;
  if (outcomes.length === 0) throw new CliError('discovery', `no running Garcon endpoint below ${options.configDir}`, 3);
  const alternatives = outcomes.map(({ candidate, error }) => {
    const selector = candidate.workspace === undefined ? { runtimeFile: candidate.descriptorPath } : { workspace: candidate.workspace };
    // Only top-level messages are shown; they carry paths and HTTP status, never the capability.
    const status = error === undefined ? 'running'
      : `unverified at ${candidate.descriptorPath}: ${error instanceof CliError ? error.message : 'unexpected failure'}`;
    return `  ${connectionCommandPrefix({ configDir: options.configDir, ...selector }).join(' ')} (${status})`;
  });
  throw new CliError('discovery', `cannot select a unique verified Garcon endpoint; use one of these command prefixes:\n${alternatives.join('\n')}`, 3);
}
