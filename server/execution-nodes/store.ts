import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExecutionLocation } from '../../common/execution-location.js';
import {
  isProviderType, isStoredProjectPath, parseExecutionNodesSnapshot,
  type ConfiguredAgentInstance, type ConfiguredExecutionNode, type ConfiguredProjectWorkspace, type ExecutionNodesSnapshot,
} from '../../common/execution-nodes.js';
import { AtomicJsonWriteError, readJsonStateFile, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { DomainError } from '../lib/domain-error.js';

export interface LocalExecutionTarget {
  readonly agentId: string;
  readonly projectPath: string;
}

export interface ResolvedExecutionLocation {
  readonly node: ConfiguredExecutionNode;
  readonly instance: ConfiguredAgentInstance;
  readonly workspace: ConfiguredProjectWorkspace;
}

export class ExecutionNodesDurabilityUnknownError extends Error {
  constructor() {
    super('Execution node configuration durability is unknown; restart before changing placement');
    this.name = 'ExecutionNodesDurabilityUnknownError';
  }
}

/** Persists resource identity before a registry entry may refer to it. Never resolves filesystem paths. */
export class ExecutionNodesStore {
  readonly #filePath: string;
  readonly #write: typeof writeJsonFileAtomic;
  readonly #lock = new KeyedPromiseLock();
  #snapshot: ExecutionNodesSnapshot | null = null;
  #uncertain = false;

  constructor(workspaceDirectory: string, options: { write?: typeof writeJsonFileAtomic } = {}) {
    this.#filePath = join(workspaceDirectory, 'execution-nodes.json');
    this.#write = options.write ?? writeJsonFileAtomic;
  }

  async init(): Promise<ExecutionNodesSnapshot> {
    return this.#lock.runExclusive(this.#filePath, async () => {
      this.#assertWritable();
      if (this.#snapshot) return this.snapshot();
      const loaded = await readJsonStateFile<ExecutionNodesSnapshot | null>({
        filePath: this.#filePath, empty: () => null,
        normalize: (value) => {
          const parsed = parseExecutionNodesSnapshot(value);
          if (!parsed) throw new Error('Invalid execution node configuration');
          return parsed;
        },
      });
      if (loaded) this.#snapshot = loaded;
      else {
        const localNodeId = randomUUID();
        await this.#commit({
          version: 1, localNodeId,
          nodes: [{ id: localNodeId, kind: 'local', label: 'Local', removedAt: null }],
          instances: [], workspaces: [],
        });
      }
      return this.snapshot();
    });
  }

  snapshot(): ExecutionNodesSnapshot {
    if (!this.#snapshot) throw new Error('Execution nodes are not initialized');
    return structuredClone(this.#snapshot);
  }

  get localNodeId(): string {
    if (!this.#snapshot) throw new Error('Execution nodes are not initialized');
    return this.#snapshot.localNodeId;
  }

  async prepareLocalTargets(targets: readonly LocalExecutionTarget[]): Promise<readonly ExecutionLocation[]> {
    const captured = targets.map((target) => {
      if (!isProviderType(target.agentId) || !isStoredProjectPath(target.projectPath)) {
        throw new TypeError('Invalid local execution target');
      }
      return { agentId: target.agentId, projectPath: target.projectPath };
    });
    return this.#lock.runExclusive(this.#filePath, async () => {
      this.#assertWritable();
      const candidate = this.snapshot();
      const instances = [...candidate.instances];
      const workspaces = [...candidate.workspaces];
      const nodeId = candidate.localNodeId;
      if (candidate.nodes.find((node) => node.id === nodeId)?.removedAt) {
        throw new DomainError('NODE_REMOVED', 'The local execution node was removed', 409);
      }
      const defaultsByAgent = new Map(instances.filter((entry) => entry.nodeId === nodeId && entry.default)
        .map((entry) => [entry.agentId, entry]));
      const workspacesByPath = new Map(workspaces.filter((entry) => entry.nodeId === nodeId && entry.removedAt === null)
        .map((entry) => [entry.projectPath, entry]));
      const locations = captured.map((target): ExecutionLocation => {
        let instance = defaultsByAgent.get(target.agentId);
        if (instance?.removedAt) throw new DomainError('NODE_REMOVED', 'The default local instance was removed', 409);
        if (!instance) {
          instance = {
            id: randomUUID(), nodeId, agentId: target.agentId, label: target.agentId,
            storageNamespace: target.agentId, default: true, removedAt: null,
          };
          instances.push(instance);
          defaultsByAgent.set(target.agentId, instance);
        }
        let workspace = workspacesByPath.get(target.projectPath);
        if (!workspace) {
          workspace = { id: randomUUID(), nodeId, projectPath: target.projectPath, removedAt: null };
          workspaces.push(workspace);
          workspacesByPath.set(target.projectPath, workspace);
        }
        return { nodeId, instanceId: instance.id, workspaceId: workspace.id };
      });
      if (instances.length !== candidate.instances.length || workspaces.length !== candidate.workspaces.length) {
        await this.#commit({ ...candidate, instances, workspaces });
      }
      return locations;
    });
  }

  async addLocalInstance(agentId: string, label: string): Promise<ConfiguredAgentInstance> {
    return this.#lock.runExclusive(this.#filePath, async () => {
      this.#assertWritable();
      const candidate = this.snapshot();
      const id = randomUUID();
      const instance: ConfiguredAgentInstance = {
        id, nodeId: candidate.localNodeId, agentId, label,
        storageNamespace: `instances/${id}`, default: false, removedAt: null,
      };
      await this.#commit({ ...candidate, instances: [...candidate.instances, instance] });
      return instance;
    });
  }

  requireKnownLocation(location: ExecutionLocation, agentId: string): ResolvedExecutionLocation {
    const snapshot = this.#snapshot;
    if (!snapshot) throw new Error('Execution nodes are not initialized');
    const node = snapshot.nodes.find((entry) => entry.id === location.nodeId);
    const instance = snapshot.instances.find((entry) => entry.id === location.instanceId && entry.nodeId === location.nodeId);
    const workspace = snapshot.workspaces.find((entry) => entry.id === location.workspaceId && entry.nodeId === location.nodeId);
    if (!node || !instance || !workspace || instance.agentId !== agentId) {
      throw new DomainError('NODE_UNAVAILABLE', 'Unknown execution location', 409);
    }
    return { node: { ...node }, instance: { ...instance }, workspace: { ...workspace } };
  }

  requireLocation(location: ExecutionLocation, agentId: string): ResolvedExecutionLocation {
    this.#assertWritable();
    const { node, instance, workspace } = this.requireKnownLocation(location, agentId);
    if (node.removedAt || instance.removedAt || workspace.removedAt) {
      throw new DomainError('NODE_REMOVED', 'Execution location was removed', 409);
    }
    return { node, instance, workspace };
  }

  #assertWritable(): void {
    if (this.#uncertain) throw new ExecutionNodesDurabilityUnknownError();
  }

  async #commit(candidate: ExecutionNodesSnapshot): Promise<void> {
    this.#assertWritable();
    const normalized = parseExecutionNodesSnapshot(candidate);
    if (!normalized) throw new TypeError('Invalid execution node configuration');
    try {
      await this.#write(this.#filePath, normalized, { mode: 0o600 });
      this.#snapshot = normalized;
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        this.#snapshot = normalized;
        this.#uncertain = true;
      }
      throw error;
    }
  }
}
