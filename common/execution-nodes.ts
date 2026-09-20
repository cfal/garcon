import { isRecord } from './json.js';

export const LOCAL_EXECUTION_NODE_ID = 'local';
export type ExecutionNodeId = string;
export type ExecutionNodeDirection = 'node-connects' | 'controller-connects';

export interface AgentExecutionTarget {
  readonly nodeId: ExecutionNodeId;
  readonly agentId: string;
}

export function effectiveNodeId(value?: string | null): ExecutionNodeId {
  return value ?? LOCAL_EXECUTION_NODE_ID;
}

export function isRemoteNodeId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

export function isExecutionNodeId(value: unknown): value is string {
  return value === LOCAL_EXECUTION_NODE_ID || isRemoteNodeId(value);
}

export function parseNodeId(value: unknown): ExecutionNodeId | null {
  return value == null ? LOCAL_EXECUTION_NODE_ID : isExecutionNodeId(value) ? value : null;
}

export interface ExecutionNodeSnapshot {
  readonly id: string;
  readonly label: string;
  readonly kind: 'local' | 'remote';
  readonly enabled: boolean;
  readonly direction: ExecutionNodeDirection | null;
  readonly availability: 'ready' | 'reconnecting' | 'offline';
  readonly projectBasePath: string | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly machineServices: {
    readonly files: boolean;
    readonly git: boolean;
    readonly terminals: boolean;
  };
}

export type CreateExecutionNodeRequest = {
  readonly label: string;
  readonly allowInsecureDevelopment?: boolean;
  readonly allowUnverifiedTls?: boolean;
} & (
  | { readonly direction: 'node-connects' }
  | { readonly direction: 'controller-connects'; readonly connectionUrl: string }
);

export interface UpdateExecutionNodeRequest {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly connection?: {
    readonly direction: ExecutionNodeDirection;
    readonly connectionUrl: string;
    readonly allowInsecureDevelopment: boolean;
    readonly allowUnverifiedTls?: boolean;
  };
}

export interface ExecutionNodeConnection {
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

export function parseCreateExecutionNodeRequest(value: unknown): CreateExecutionNodeRequest | null {
  if (!isRecord(value) || !isLabel(value.label)
    || value.allowInsecureDevelopment !== undefined && typeof value.allowInsecureDevelopment !== 'boolean'
    || value.allowUnverifiedTls !== undefined && typeof value.allowUnverifiedTls !== 'boolean') return null;
  const common = { label: value.label.trim(), allowInsecureDevelopment: value.allowInsecureDevelopment, allowUnverifiedTls: value.allowUnverifiedTls };
  if (value.direction === 'node-connects' && value.allowUnverifiedTls !== true
    && hasOnlyKeys(value, ['label', 'direction', 'allowInsecureDevelopment', 'allowUnverifiedTls'])) {
    return { ...common, direction: 'node-connects' };
  }
  if (value.direction === 'controller-connects' && isConnectionUrl(value.connectionUrl)
    && hasOnlyKeys(value, ['label', 'direction', 'connectionUrl', 'allowInsecureDevelopment', 'allowUnverifiedTls'])) {
    return { ...common, direction: 'controller-connects', connectionUrl: value.connectionUrl };
  }
  return null;
}

export function parseUpdateExecutionNodeRequest(value: unknown): UpdateExecutionNodeRequest | null {
  if (!isRecord(value) || Object.keys(value).length === 0 || !hasOnlyKeys(value, ['label', 'enabled', 'connection'])
    || value.label !== undefined && !isLabel(value.label)
    || value.enabled !== undefined && typeof value.enabled !== 'boolean') return null;
  const connection = value.connection;
  if (connection !== undefined && (!isRecord(connection)
    || !hasOnlyKeys(connection, ['direction', 'connectionUrl', 'allowInsecureDevelopment', 'allowUnverifiedTls'])
    || (connection.direction !== 'node-connects' && connection.direction !== 'controller-connects')
    || connection.allowUnverifiedTls !== undefined && typeof connection.allowUnverifiedTls !== 'boolean'
    || connection.direction === 'node-connects' && connection.allowUnverifiedTls === true
    || !isConnectionUrl(connection.connectionUrl) || typeof connection.allowInsecureDevelopment !== 'boolean')) return null;
  return {
    ...(value.label === undefined ? {} : { label: (value.label as string).trim() }),
    ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean }),
    ...(connection === undefined ? {} : { connection: connection as NonNullable<UpdateExecutionNodeRequest['connection']> }),
  };
}

export function parseExecutionNodeSnapshot(value: unknown): ExecutionNodeSnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'label', 'kind', 'enabled', 'direction', 'availability', 'projectBasePath', 'lastError', 'machineServices'])
    || !isExecutionNodeId(value.id) || !isLabel(value.label) || typeof value.enabled !== 'boolean'
    || (value.availability !== 'ready' && value.availability !== 'offline' && value.availability !== 'reconnecting')
    || !(value.projectBasePath === null || typeof value.projectBasePath === 'string')) return null;
  if (value.id === LOCAL_EXECUTION_NODE_ID
    ? value.kind !== 'local' || value.direction !== null || !value.enabled
    : value.kind !== 'remote' || (value.direction !== 'node-connects' && value.direction !== 'controller-connects')) return null;
  const services = value.machineServices;
  if (!isRecord(services) || !hasOnlyKeys(services, ['files', 'git', 'terminals'])
    || typeof services.files !== 'boolean' || typeof services.git !== 'boolean' || typeof services.terminals !== 'boolean') return null;
  const error = value.lastError;
  if (error !== null && (!isRecord(error) || !hasOnlyKeys(error, ['code', 'message'])
    || typeof error.code !== 'string' || typeof error.message !== 'string')) return null;
  return value as unknown as ExecutionNodeSnapshot;
}

export function parseExecutionNodes(value: unknown): readonly ExecutionNodeSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const nodes: ExecutionNodeSnapshot[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const node = parseExecutionNodeSnapshot(candidate);
    if (!node || ids.has(node.id)) return null;
    ids.add(node.id);
    nodes.push(node);
  }
  return nodes;
}
