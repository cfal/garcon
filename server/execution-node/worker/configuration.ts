import path from 'node:path';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { isExecutionResourceLabel, isProviderType } from '../../../common/execution-nodes.js';
import { isNormalizedJsonObject } from '@garcon/server-agent-interface';
import { exactNodeFields, nodeString } from '../../execution-nodes/transport/private-json.js';
import { DEFAULT_NODE_REPLAY, type NodeReplayOptions } from '../replay-cache.js';

export const MAX_NODE_WORKER_CONFIGURATION_BYTES = 512 * 1024;
export const MAX_NODE_WORKER_INSTANCES = 64;
export const MAX_NODE_WORKER_WORKSPACES = 256;
export const DEFAULT_NODE_EXECUTABLE_SEARCH_PATH: readonly string[] = Object.freeze(['/usr/local/bin', '/usr/bin', '/bin']);

export interface NodeInstanceConfiguration {
  readonly id: string;
  readonly agentId: string;
  readonly label: string;
  readonly homeDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workspaceIds: readonly string[];
  readonly maxOperations: number;
}

export interface NodeWorkspaceConfiguration {
  readonly id: string;
  readonly projectPath: string;
}

export interface NodeSessionWorkerConfiguration {
  readonly role: 'session';
  readonly nodeId: string;
  readonly storageDirectory: string;
  readonly executableSearchPath: readonly string[];
  readonly instances: readonly NodeInstanceConfiguration[];
  readonly workspaces: readonly NodeWorkspaceConfiguration[];
  readonly replay: NodeReplayOptions;
  readonly outputMemoryBytes?: number;
}

export interface NodeInstanceWorkerConfiguration {
  readonly role: 'instance';
  readonly nodeId: string;
  readonly storageDirectory: string;
  readonly executableSearchPath: readonly string[];
  readonly instance: NodeInstanceConfiguration;
  readonly workspaces: readonly NodeWorkspaceConfiguration[];
}

export type NodeWorkerConfiguration = NodeSessionWorkerConfiguration | NodeInstanceWorkerConfiguration;

export function parseNodeWorkerConfiguration(value: unknown): NodeWorkerConfiguration | null {
  if (!isNormalizedJsonObject(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_NODE_WORKER_CONFIGURATION_BYTES
    || !exactNodeFields(value, ['role', 'nodeId', 'storageDirectory', 'executableSearchPath', 'workspaces'], ['instances', 'instance', 'replay', 'outputMemoryBytes'])
    || !isExecutionIdentity(value.nodeId) || !absoluteDirectory(value.storageDirectory)
    || !Array.isArray(value.workspaces) || value.workspaces.length > MAX_NODE_WORKER_WORKSPACES) return null;
  const executableSearchPath = parseNodeExecutableSearchPath(value.executableSearchPath);
  if (!executableSearchPath) return null;
  const workspaces: NodeWorkspaceConfiguration[] = [];
  for (const entry of value.workspaces) {
    if (!exactNodeFields(entry, ['id', 'projectPath']) || !isExecutionIdentity(entry.id) || !absoluteDirectory(entry.projectPath)
      || workspaces.some((prior) => prior.id === entry.id)) return null;
    workspaces.push(Object.freeze({ id: entry.id, projectPath: entry.projectPath }));
  }
  const base = { nodeId: value.nodeId, storageDirectory: value.storageDirectory, executableSearchPath, workspaces: Object.freeze(workspaces) };
  if (value.role === 'instance') {
    if (!exactNodeFields(value, ['role', 'nodeId', 'storageDirectory', 'executableSearchPath', 'workspaces', 'instance'])) return null;
    const instance = parseInstance(value.instance, workspaces);
    return instance ? Object.freeze({ role: 'instance', ...base, instance }) : null;
  }
  if (value.role !== 'session' || !exactNodeFields(value, ['role', 'nodeId', 'storageDirectory', 'executableSearchPath', 'workspaces', 'instances', 'replay'], ['outputMemoryBytes'])
    || !Array.isArray(value.instances) || value.instances.length > MAX_NODE_WORKER_INSTANCES) return null;
  if (value.outputMemoryBytes !== undefined && (!Number.isSafeInteger(value.outputMemoryBytes) || Number(value.outputMemoryBytes) < 1)) return null;
  const outputMemory = value.outputMemoryBytes === undefined ? {} : { outputMemoryBytes: Number(value.outputMemoryBytes) };
  const instances: NodeInstanceConfiguration[] = [];
  for (const entry of value.instances) {
    const instance = parseInstance(entry, workspaces);
    if (!instance || instances.some((prior) => prior.id === instance.id || pathsOverlap(prior.homeDirectory, instance.homeDirectory))) return null;
    instances.push(instance);
  }
  const replay = parseReplay(value.replay);
  return replay ? Object.freeze({ role: 'session', ...base, instances: Object.freeze(instances), replay, ...outputMemory }) : null;
}

function parseInstance(value: unknown, workspaces: readonly NodeWorkspaceConfiguration[]): NodeInstanceConfiguration | null {
  if (!exactNodeFields(value, ['id', 'agentId', 'label', 'homeDirectory', 'environment', 'workspaceIds', 'maxOperations'])
    || !isExecutionIdentity(value.id) || !isProviderType(value.agentId) || !isExecutionResourceLabel(value.label)
    || !absoluteDirectory(value.homeDirectory) || !isNormalizedJsonObject(value.environment)
    || !Array.isArray(value.workspaceIds) || value.workspaceIds.length > MAX_NODE_WORKER_WORKSPACES
    || !value.workspaceIds.every((id) => isExecutionIdentity(id) && workspaces.some((workspace) => workspace.id === id))
    || new Set(value.workspaceIds).size !== value.workspaceIds.length
    || !Number.isSafeInteger(value.maxOperations) || Number(value.maxOperations) < 1 || Number(value.maxOperations) > 256) return null;
  const environment: Record<string, string> = {};
  const entries = Object.entries(value.environment);
  if (entries.length > 128 || Buffer.byteLength(JSON.stringify(value.environment)) > 64 * 1024) return null;
  for (const [key, input] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || !nodeString(input, 16_384, true)
      || OWNED_ENVIRONMENT_KEYS.has(key)) return null;
    environment[key] = input;
  }
  return Object.freeze({ id: value.id, agentId: value.agentId, label: value.label, homeDirectory: value.homeDirectory,
    environment: Object.freeze(environment), workspaceIds: Object.freeze([...value.workspaceIds]), maxOperations: Number(value.maxOperations) });
}

function parseReplay(value: unknown): NodeReplayOptions | null {
  if (!exactNodeFields(value, ['enabled', 'maxAgeMs', 'maxBytes']) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.maxAgeMs) || Number(value.maxAgeMs) < 1 || Number(value.maxAgeMs) > DEFAULT_NODE_REPLAY.maxAgeMs
    || !Number.isSafeInteger(value.maxBytes) || Number(value.maxBytes) < 1 || Number(value.maxBytes) > DEFAULT_NODE_REPLAY.maxBytes) return null;
  return Object.freeze({ enabled: value.enabled, maxAgeMs: Number(value.maxAgeMs), maxBytes: Number(value.maxBytes) });
}

export function pathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  return contains(left, right) || contains(right, left);
}

function absoluteDirectory(value: unknown): value is string {
  return nodeString(value, 32_768) && path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root;
}

export function parseNodeExecutableSearchPath(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32
    || !value.every((entry) => absoluteDirectory(entry) && !entry.includes(path.delimiter))
    || new Set(value).size !== value.length || Buffer.byteLength(value.join(path.delimiter)) > 32_768) return null;
  return Object.freeze([...value]);
}

export const OWNED_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  'PATH', 'LANG', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'TMPDIR', 'TMP', 'TEMP', 'GARCON_CONFIG_DIR', 'GARCON_WORKSPACE_DIR', 'GARCON_WORKSPACE',
  'BUN_OPTIONS', 'NODE_OPTIONS',
]);
