import { isExecutorId } from './executors.js';
import { CLI_BOOTSTRAP_VERSION } from './cli-contracts.js';
import { isProtocolOffer, intersectContracts, type ProtocolOffer } from './protocol-contracts.js';

export const SERVER_RUNTIME_SCHEMA_VERSION = 1 as const;
export const SERVER_RUNTIME_FILENAME = 'runtime.json';
export const LOCAL_CAPABILITY_PREFIX = 'garcon_local_';
export const SERVER_RUNTIME_PROOF_CONTEXT = 'garcon-runtime-proof-v1';
export const CLI_SERVER_INSTANCE_HEADER = 'X-Garcon-Server-Instance';

export interface CliIdentityV1 {
  readonly serverInstanceId: string;
  readonly defaultExecutorId: string;
  readonly workspaceName: string | null;
}

export interface CliContext extends CliIdentityV1 {
  readonly protocol: ProtocolOffer;
}

export function parseCliIdentity(value: unknown): CliIdentityV1 {
  const raw = runtimeRecord(value);
  if (!isExecutorId(raw.defaultExecutorId)
    || !(raw.workspaceName === null || typeof raw.workspaceName === 'string' && raw.workspaceName.length > 0)) {
    throw new ServerRuntimeContractError('invalid CLI context');
  }
  return {
    serverInstanceId: requiredString(raw, 'serverInstanceId'),
    defaultExecutorId: raw.defaultExecutorId,
    workspaceName: raw.workspaceName,
  };
}

export function parseCliContext(value: unknown): CliContext {
  const identity = parseCliIdentity(value);
  const raw = runtimeRecord(value);
  if (!isProtocolOffer(raw.protocol) || raw.protocol.bootstrap !== CLI_BOOTSTRAP_VERSION
    || Object.keys(raw.protocol.contracts).some(name => !name.startsWith('cli.'))) {
    throw new ServerRuntimeContractError('unsupported CLI bootstrap or invalid contract catalog');
  }
  return { ...identity, protocol: Object.freeze({ bootstrap: CLI_BOOTSTRAP_VERSION,
    contracts: intersectContracts(raw.protocol.contracts, raw.protocol.contracts) }) };
}

export interface ServerRuntimeProbe {
  schemaVersion: typeof SERVER_RUNTIME_SCHEMA_VERSION;
  instanceId: string;
  proof: string;
}

export interface ServerRuntimeIdentity {
  schemaVersion: typeof SERVER_RUNTIME_SCHEMA_VERSION;
  instanceId: string;
  workspaceDir: string;
  startedAt: string;
}

export interface ServerRuntimeDescriptor extends ServerRuntimeIdentity {
  pid: number;
  baseUrl: string;
  localCapability: string;
}

export interface CliGatewayDescriptor extends Omit<ServerRuntimeDescriptor, 'workspaceDir'> {
  readonly kind: 'executor-cli';
}

export type CliRuntimeDescriptor = ServerRuntimeDescriptor | CliGatewayDescriptor;

export class ServerRuntimeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerRuntimeContractError';
  }
}

export function parseServerRuntimeProbe(value: unknown): ServerRuntimeProbe {
  const raw = runtimeRecord(value);
  requireSchema(raw);
  return {
    schemaVersion: SERVER_RUNTIME_SCHEMA_VERSION,
    instanceId: requiredString(raw, 'instanceId'),
    proof: base64Url32(raw, 'proof'),
  };
}

export function parseServerRuntimeDescriptor(value: unknown): ServerRuntimeDescriptor {
  const raw = runtimeRecord(value);
  return { ...parseRuntimeEndpoint(raw), workspaceDir: requiredString(raw, 'workspaceDir') };
}

export function parseCliRuntimeDescriptor(value: unknown): CliRuntimeDescriptor {
  const raw = runtimeRecord(value);
  if (raw.kind === 'executor-cli') return { ...parseRuntimeEndpoint(raw), kind: raw.kind };
  if (raw.kind !== undefined) throw new ServerRuntimeContractError('unsupported runtime kind');
  return parseServerRuntimeDescriptor(raw);
}

function parseRuntimeEndpoint(value: unknown): Omit<ServerRuntimeDescriptor, 'workspaceDir'> {
  const raw = runtimeRecord(value);
  requireSchema(raw);
  const pid = raw.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
    throw new ServerRuntimeContractError('pid must be a positive integer');
  }
  const startedAt = requiredString(raw, 'startedAt');
  if (!Number.isFinite(Date.parse(startedAt))) {
    throw new ServerRuntimeContractError('startedAt must be an ISO timestamp');
  }
  const baseUrl = requiredString(raw, 'baseUrl');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new ServerRuntimeContractError('baseUrl must be an absolute URL');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ServerRuntimeContractError('baseUrl must use HTTP or HTTPS');
  }
  const localCapability = requiredString(raw, 'localCapability');
  if (!isLocalCapability(localCapability)) {
    throw new ServerRuntimeContractError('localCapability is invalid');
  }
  return {
    schemaVersion: SERVER_RUNTIME_SCHEMA_VERSION,
    instanceId: requiredString(raw, 'instanceId'),
    startedAt,
    pid: Number(pid),
    baseUrl: parsedUrl.toString().replace(/\/$/, ''),
    localCapability,
  };
}

export function isLocalCapability(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith(LOCAL_CAPABILITY_PREFIX)
    && /^[A-Za-z0-9_-]{43}$/.test(value.slice(LOCAL_CAPABILITY_PREFIX.length));
}

export function isRuntimeProbeChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function runtimeProofPayload(instanceId: string, challenge: string): string {
  return `${SERVER_RUNTIME_PROOF_CONTEXT}\0${instanceId}\0${challenge}`;
}

function runtimeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServerRuntimeContractError('runtime payload must be an object');
  }
  return value as Record<string, unknown>;
}

function requireSchema(raw: Record<string, unknown>): void {
  if (raw.schemaVersion !== SERVER_RUNTIME_SCHEMA_VERSION) {
    throw new ServerRuntimeContractError('unsupported runtime schema version');
  }
}

function requiredString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ServerRuntimeContractError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function base64Url32(raw: Record<string, unknown>, field: string): string {
  const value = requiredString(raw, field);
  if (!isRuntimeProbeChallenge(value)) {
    throw new ServerRuntimeContractError(`${field} must be 32-byte base64url data`);
  }
  return value;
}
