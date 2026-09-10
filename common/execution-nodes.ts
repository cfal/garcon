import { isRecord } from './json.js';
import { isExecutionIdentity } from './execution-location.js';

export interface ConfiguredExecutionNode {
  readonly id: string;
  readonly kind: 'local' | 'remote';
  readonly label: string;
  readonly removedAt: string | null;
}

export interface ConfiguredAgentInstance {
  readonly id: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly label: string;
  readonly storageNamespace: string;
  readonly default: boolean;
  readonly removedAt: string | null;
}

export interface ConfiguredProjectWorkspace {
  readonly id: string;
  readonly nodeId: string;
  readonly projectPath: string;
  readonly removedAt: string | null;
}

export interface ExecutionNodesSnapshot {
  readonly version: 1;
  readonly localNodeId: string;
  readonly nodes: readonly ConfiguredExecutionNode[];
  readonly instances: readonly ConfiguredAgentInstance[];
  readonly workspaces: readonly ConfiguredProjectWorkspace[];
}

export function parseExecutionNodesSnapshot(value: unknown): ExecutionNodesSnapshot | null {
  if (!isRecord(value) || !keys(value, ['version', 'localNodeId', 'nodes', 'instances', 'workspaces'])
    || value.version !== 1 || !isExecutionIdentity(value.localNodeId)
    || !Array.isArray(value.nodes) || !Array.isArray(value.instances) || !Array.isArray(value.workspaces)) return null;
  const nodes: ConfiguredExecutionNode[] = [];
  const instances: ConfiguredAgentInstance[] = [];
  const workspaces: ConfiguredProjectWorkspace[] = [];
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (!isRecord(node) || !keys(node, ['id', 'kind', 'label', 'removedAt'])
      || !uniqueIdentity(node.id, ids) || (node.kind !== 'local' && node.kind !== 'remote')
      || !label(node.label) || !removalTime(node.removedAt)) return null;
    nodes.push({ id: node.id, kind: node.kind, label: node.label, removedAt: node.removedAt });
  }
  const local = nodes.filter((node) => node.kind === 'local');
  if (local.length !== 1 || local[0]!.id !== value.localNodeId || local[0]!.removedAt !== null) return null;
  const defaults = new Set<string>();
  const storage = new Set<string>();
  const instanceIds = new Set<string>();
  for (const instance of value.instances) {
    if (!isRecord(instance) || !keys(instance, ['id', 'nodeId', 'agentId', 'label', 'storageNamespace', 'default', 'removedAt'])
      || !isExecutionIdentity(instance.id) || !isExecutionIdentity(instance.nodeId)
      || !nodes.some((node) => node.id === instance.nodeId) || !isProviderType(instance.agentId)
      || !label(instance.label) || typeof instance.default !== 'boolean' || !removalTime(instance.removedAt)
      || typeof instance.storageNamespace !== 'string'
      || (instance.storageNamespace !== instance.agentId && instance.storageNamespace !== `instances/${instance.id}`)) return null;
    const storageKey = JSON.stringify([instance.nodeId, instance.storageNamespace]);
    const defaultKey = JSON.stringify([instance.nodeId, instance.agentId]);
    const instanceKey = JSON.stringify([instance.nodeId, instance.id]);
    if (instanceIds.has(instanceKey) || storage.has(storageKey) || (instance.default && defaults.has(defaultKey))) return null;
    instanceIds.add(instanceKey);
    storage.add(storageKey);
    if (instance.default) defaults.add(defaultKey);
    instances.push({
      id: instance.id, nodeId: instance.nodeId, agentId: instance.agentId, label: instance.label,
      storageNamespace: instance.storageNamespace, default: instance.default, removedAt: instance.removedAt,
    });
  }
  const projects = new Set<string>();
  const workspaceIds = new Set<string>();
  for (const workspace of value.workspaces) {
    if (!isRecord(workspace) || !keys(workspace, ['id', 'nodeId', 'projectPath', 'removedAt'])
      || !isExecutionIdentity(workspace.id) || !isExecutionIdentity(workspace.nodeId)
      || !nodes.some((node) => node.id === workspace.nodeId) || !isStoredProjectPath(workspace.projectPath)
      || !removalTime(workspace.removedAt)) return null;
    const projectKey = JSON.stringify([workspace.nodeId, workspace.projectPath]);
    const workspaceKey = JSON.stringify([workspace.nodeId, workspace.id]);
    if (workspaceIds.has(workspaceKey) || (workspace.removedAt === null && projects.has(projectKey))) return null;
    workspaceIds.add(workspaceKey);
    if (workspace.removedAt === null) projects.add(projectKey);
    workspaces.push({ id: workspace.id, nodeId: workspace.nodeId, projectPath: workspace.projectPath, removedAt: workspace.removedAt });
  }
  return { version: 1, localNodeId: value.localNodeId, nodes, instances, workspaces };
}

export function isStoredProjectPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 32_768 && !value.includes('\0');
}

export function isProviderType(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function label(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[\r\n\0]/.test(value);
}

function removalTime(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function uniqueIdentity(value: unknown, ids: Set<string>): value is string {
  if (!isExecutionIdentity(value) || ids.has(value)) return false;
  ids.add(value);
  return true;
}
