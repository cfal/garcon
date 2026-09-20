import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRemoteNodeId, parseCreateExecutionNodeRequest, parseUpdateExecutionNodeRequest,
  type CreateExecutionNodeRequest, type UpdateExecutionNodeRequest,
} from '../../common/execution-nodes.js';
import { isRecord } from '../../common/json.js';
import { DomainError, ValidationDomainError } from '../lib/domain-error.js';
import { AtomicJsonWriteError, readJsonStateFile, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { createNodeSecret, isNodeSecret, nodeConnectionUrl, parseConnectionUrl, validateNodeSocketUrl } from './connection-url.js';

export interface RemoteNodeConfig {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly secret: string;
  readonly connection:
    | { readonly kind: 'node-connects'; readonly advertisedUrl: string }
    | { readonly kind: 'controller-connects'; readonly targetUrl: string };
  readonly allowInsecureDevelopment: boolean;
  readonly allowUnverifiedTls: boolean;
}

export class ExecutionNodeConfigStore {
  readonly #path: string;
  #nodes: readonly RemoteNodeConfig[] = [];
  #pending: Promise<unknown> = Promise.resolve();

  constructor(workspaceDir: string) { this.#path = join(workspaceDir, 'execution-nodes.json'); }

  async initialize(): Promise<void> {
    await assertPrivateNodeFile(this.#path);
    this.#nodes = await readJsonStateFile({
      filePath: this.#path,
      empty: () => [],
      normalize: (value) => {
        if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.nodes)) {
          throw new Error('Invalid execution-node configuration');
        }
        const nodes = value.nodes.map(parseStoredNode);
        assertUniqueNodes(nodes);
        return nodes;
      },
    });
  }

  list(): readonly RemoteNodeConfig[] { return structuredClone(this.#nodes); }

  get(id: string): RemoteNodeConfig | null {
    const node = this.#nodes.find((entry) => entry.id === id);
    return node ? structuredClone(node) : null;
  }

  require(id: string): RemoteNodeConfig {
    const node = this.get(id);
    if (!node) throw new DomainError('EXECUTION_NODE_NOT_FOUND', 'Execution node not found', 404);
    return node;
  }

  connection(id: string) {
    const node = this.require(id);
    return {
      connectionUrl: nodeConnectionUrl(node.connection.kind === 'node-connects' ? node.connection.advertisedUrl : node.connection.targetUrl, node.secret),
      allowInsecureDevelopment: node.allowInsecureDevelopment,
      allowUnverifiedTls: node.allowUnverifiedTls,
    };
  }

  create(input: CreateExecutionNodeRequest): Promise<RemoteNodeConfig> {
    return this.#serialize(async () => {
      const request = parseCreateExecutionNodeRequest(input);
      if (!request) throw new ValidationDomainError('Invalid execution-node configuration');
      const id = randomUUID();
      const allowInsecureDevelopment = request.allowInsecureDevelopment ?? false;
      const parsed = request.direction === 'controller-connects' ? parseConnectionUrl(request.connectionUrl) : null;
      const node: RemoteNodeConfig = {
        id, label: request.label, enabled: true, allowInsecureDevelopment,
        allowUnverifiedTls: parsed?.socketUrl.startsWith('wss:') === true && request.allowUnverifiedTls === true,
        secret: parsed?.secret ?? createNodeSecret(),
        connection: parsed
          ? { kind: 'controller-connects', targetUrl: validateNodeSocketUrl(parsed.socketUrl, { direction: 'controller-connects', allowInsecureDevelopment }) }
          : { kind: 'node-connects', advertisedUrl: `wss://example.com/execution-node/${id}` },
      };
      await this.#save([...this.#nodes, node]);
      return structuredClone(node);
    });
  }

  update(id: string, input: UpdateExecutionNodeRequest): Promise<RemoteNodeConfig> {
    return this.#serialize(async () => {
      const request = parseUpdateExecutionNodeRequest(input);
      if (!request) throw new ValidationDomainError('Invalid execution-node update');
      const previous = this.require(id);
      let node: RemoteNodeConfig = {
        ...previous,
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      };
      if (request.connection) {
        const { direction, connectionUrl, allowInsecureDevelopment } = request.connection;
        const parsed = parseConnectionUrl(connectionUrl);
        const socketUrl = validateNodeSocketUrl(parsed.socketUrl, { direction, allowInsecureDevelopment, nodeId: id });
        node = {
          ...node, secret: parsed.secret, allowInsecureDevelopment,
          allowUnverifiedTls: direction === 'controller-connects' && socketUrl.startsWith('wss:') && request.connection.allowUnverifiedTls === true,
          connection: direction === 'node-connects' ? { kind: direction, advertisedUrl: socketUrl } : { kind: direction, targetUrl: socketUrl },
        };
      }
      await this.#save(this.#nodes.map((entry) => entry.id === id ? node : entry));
      return structuredClone(node);
    });
  }

  remove(id: string): Promise<void> {
    return this.#serialize(async () => {
      this.require(id);
      await this.#save(this.#nodes.filter((entry) => entry.id !== id));
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation);
    this.#pending = result.catch(() => undefined);
    return result;
  }

  async #save(nodes: readonly RemoteNodeConfig[]): Promise<void> {
    assertUniqueNodes(nodes);
    try {
      await writeJsonFileAtomic(this.#path, { version: 1, nodes }, { mode: 0o600 });
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) this.#nodes = nodes;
      throw error;
    }
    this.#nodes = nodes;
  }
}

function parseStoredNode(value: unknown): RemoteNodeConfig {
  if (!isRecord(value) || !isRemoteNodeId(value.id) || typeof value.label !== 'string'
    || !value.label.trim() || value.label.length > 100 || typeof value.enabled !== 'boolean'
    || !isNodeSecret(value.secret) || typeof value.allowInsecureDevelopment !== 'boolean'
    || value.allowUnverifiedTls !== undefined && typeof value.allowUnverifiedTls !== 'boolean'
    || !isRecord(value.connection)) throw new Error('Invalid execution-node configuration');
  const options = { nodeId: value.id, allowInsecureDevelopment: value.allowInsecureDevelopment };
  const connection = value.connection.kind === 'node-connects' && typeof value.connection.advertisedUrl === 'string'
    ? { kind: 'node-connects' as const, advertisedUrl: validateNodeSocketUrl(value.connection.advertisedUrl, { ...options, direction: 'node-connects' }) }
    : value.connection.kind === 'controller-connects' && typeof value.connection.targetUrl === 'string'
      ? { kind: 'controller-connects' as const, targetUrl: validateNodeSocketUrl(value.connection.targetUrl, { ...options, direction: 'controller-connects' }) }
      : null;
  if (!connection || connection.kind === 'node-connects' && value.allowUnverifiedTls === true) throw new Error('Invalid execution-node connection configuration');
  return { id: value.id, label: value.label, enabled: value.enabled, secret: value.secret, connection,
    allowInsecureDevelopment: value.allowInsecureDevelopment,
    allowUnverifiedTls: connection.kind === 'controller-connects' && connection.targetUrl.startsWith('wss:') && value.allowUnverifiedTls === true };
}

function assertUniqueNodes(nodes: readonly RemoteNodeConfig[]): void {
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length || new Set(nodes.map((node) => node.secret)).size !== nodes.length) {
    throw new ValidationDomainError('Execution nodes must have unique IDs and shared secrets');
  }
}

export async function assertPrivateNodeFile(filePath: string): Promise<void> {
  try {
    const details = await stat(filePath);
    if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
      throw new Error('Execution-node configuration must be accessible only to its OS account');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
