import { isRecord } from './json.js';

export const LOCAL_EXECUTOR_ID = 'local';
export type ExecutorId = string;
export type ExecutorDirection = 'executor-connects' | 'controller-connects';

export interface AgentExecutionTarget {
  readonly executorId: ExecutorId;
  readonly agentId: string;
}

export function effectiveExecutorId(value?: string | null): ExecutorId {
  return value ?? LOCAL_EXECUTOR_ID;
}

export function isRemoteExecutorId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

export function isExecutorId(value: unknown): value is string {
  return value === LOCAL_EXECUTOR_ID || isRemoteExecutorId(value);
}

export function parseExecutorId(value: unknown): ExecutorId | null {
  return value == null ? LOCAL_EXECUTOR_ID : isExecutorId(value) ? value : null;
}

export interface ExecutorSnapshot {
  readonly id: string;
  readonly label: string;
  readonly kind: 'local' | 'remote';
  readonly enabled: boolean;
  readonly allowControllerCli: boolean;
  readonly direction: ExecutorDirection | null;
  readonly availability: 'ready' | 'offline';
  readonly instanceId: string | null;
  readonly projectBasePath: string | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly machineServices: {
    readonly files: boolean;
    readonly git: boolean;
    readonly gh: boolean;
    readonly terminals: boolean;
  };
}

export type CreateExecutorRequest = {
  readonly label: string;
  readonly allowControllerCli?: boolean;
  readonly allowInsecureDevelopment?: boolean;
  readonly allowUnverifiedTls?: boolean;
} & (
  | { readonly direction: 'executor-connects' }
  | { readonly direction: 'controller-connects'; readonly connectionUrl: string }
);

export interface UpdateExecutorRequest {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly allowControllerCli?: boolean;
  readonly connection?: {
    readonly direction: ExecutorDirection;
    readonly connectionUrl: string;
    readonly allowInsecureDevelopment: boolean;
    readonly allowUnverifiedTls?: boolean;
  };
}

export interface ExecutorConnection {
  readonly connectionUrl: string;
  readonly allowInsecureDevelopment: boolean;
  readonly allowUnverifiedTls: boolean;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
}

function isConnectionUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

export function parseCreateExecutorRequest(value: unknown): CreateExecutorRequest | null {
  if (!isRecord(value) || !isLabel(value.label)
    || value.allowControllerCli !== undefined && typeof value.allowControllerCli !== 'boolean'
    || value.allowInsecureDevelopment !== undefined && typeof value.allowInsecureDevelopment !== 'boolean'
    || value.allowUnverifiedTls !== undefined && typeof value.allowUnverifiedTls !== 'boolean') return null;
  const common = { label: value.label.trim(),
    ...(value.allowControllerCli === undefined ? {} : { allowControllerCli: value.allowControllerCli }),
    allowInsecureDevelopment: value.allowInsecureDevelopment, allowUnverifiedTls: value.allowUnverifiedTls };
  if (value.direction === 'executor-connects' && value.allowUnverifiedTls !== true
    && hasOnlyKeys(value, ['label', 'direction', 'allowInsecureDevelopment', 'allowUnverifiedTls', 'allowControllerCli'])) {
    return { ...common, direction: 'executor-connects' };
  }
  if (value.direction === 'controller-connects' && isConnectionUrl(value.connectionUrl)
    && hasOnlyKeys(value, ['label', 'direction', 'connectionUrl', 'allowInsecureDevelopment', 'allowUnverifiedTls', 'allowControllerCli'])) {
    return { ...common, direction: 'controller-connects', connectionUrl: value.connectionUrl };
  }
  return null;
}

export function parseUpdateExecutorRequest(value: unknown): UpdateExecutorRequest | null {
  if (!isRecord(value) || Object.keys(value).length === 0 || !hasOnlyKeys(value, ['label', 'enabled', 'connection', 'allowControllerCli'])
    || value.allowControllerCli !== undefined && typeof value.allowControllerCli !== 'boolean'
    || value.label !== undefined && !isLabel(value.label)
    || value.enabled !== undefined && typeof value.enabled !== 'boolean') return null;
  const connection = value.connection;
  if (connection !== undefined && (!isRecord(connection)
    || !hasOnlyKeys(connection, ['direction', 'connectionUrl', 'allowInsecureDevelopment', 'allowUnverifiedTls'])
    || (connection.direction !== 'executor-connects' && connection.direction !== 'controller-connects')
    || connection.allowUnverifiedTls !== undefined && typeof connection.allowUnverifiedTls !== 'boolean'
    || connection.direction === 'executor-connects' && connection.allowUnverifiedTls === true
    || !isConnectionUrl(connection.connectionUrl) || typeof connection.allowInsecureDevelopment !== 'boolean')) return null;
  return {
    ...(value.label === undefined ? {} : { label: (value.label as string).trim() }),
    ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean }),
    ...(value.allowControllerCli === undefined ? {} : { allowControllerCli: value.allowControllerCli as boolean }),
    ...(connection === undefined ? {} : { connection: connection as NonNullable<UpdateExecutorRequest['connection']> }),
  };
}

export function parseExecutorSnapshot(value: unknown): ExecutorSnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'label', 'kind', 'enabled', 'direction', 'availability', 'instanceId', 'projectBasePath', 'lastError', 'machineServices', 'allowControllerCli'])
    || typeof value.allowControllerCli !== 'boolean'
    || !isExecutorId(value.id) || !isLabel(value.label) || typeof value.enabled !== 'boolean'
    || (value.availability !== 'ready' && value.availability !== 'offline')
    || !(value.instanceId === null || typeof value.instanceId === 'string' && value.instanceId.length > 0 && value.instanceId.length <= 128)
    || !(value.projectBasePath === null || typeof value.projectBasePath === 'string')) return null;
  if (value.id === LOCAL_EXECUTOR_ID
    ? value.kind !== 'local' || value.direction !== null || !value.enabled
    : value.kind !== 'remote' || (value.direction !== 'executor-connects' && value.direction !== 'controller-connects')) return null;
  const services = value.machineServices;
  if (!isRecord(services) || !hasOnlyKeys(services, ['files', 'git', 'gh', 'terminals'])
    || typeof services.files !== 'boolean' || typeof services.git !== 'boolean' || typeof services.gh !== 'boolean' || typeof services.terminals !== 'boolean') return null;
  const error = value.lastError;
  if (error !== null && (!isRecord(error) || !hasOnlyKeys(error, ['code', 'message'])
    || typeof error.code !== 'string' || typeof error.message !== 'string')) return null;
  return value as unknown as ExecutorSnapshot;
}

export function parseExecutors(value: unknown): readonly ExecutorSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const executors: ExecutorSnapshot[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const executor = parseExecutorSnapshot(candidate);
    if (!executor || ids.has(executor.id)) return null;
    ids.add(executor.id);
    executors.push(executor);
  }
  return executors;
}
