import { randomUUID } from 'node:crypto';
import { assertPrivateFile } from '../../common/private-file.js';
import { join } from 'node:path';
import {
  isRemoteExecutorId, parseCreateExecutorRequest, parseUpdateExecutorRequest,
  type CreateExecutorRequest, type UpdateExecutorRequest,
} from '../../../common/executors.js';
import { isRecord } from '../../../common/json.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { AtomicJsonWriteError, readJsonStateFile, writeJsonFileAtomic } from '../../common/json-file-store.js';
import { createExecutorSecret, isExecutorSecret, executorConnectionUrl, parseConnectionUrl, validateExecutorSocketUrl } from '../../remote/transport/connection-url.js';

export interface RemoteExecutorConfig {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly allowControllerCli: boolean;
  readonly secret: string;
  readonly connection:
    | { readonly kind: 'executor-connects'; readonly advertisedUrl: string }
    | { readonly kind: 'controller-connects'; readonly targetUrl: string };
  readonly allowInsecureDevelopment: boolean;
  readonly allowUnverifiedTls: boolean;
}

export class ExecutorConfigStore {
  readonly #path: string;
  #executors: readonly RemoteExecutorConfig[] = [];
  #pending: Promise<unknown> = Promise.resolve();

  constructor(workspaceDir: string) { this.#path = join(workspaceDir, 'executors.json'); }

  async initialize(): Promise<void> {
    await assertPrivateFile(this.#path);
    this.#executors = await readJsonStateFile({
      filePath: this.#path,
      empty: () => [],
      normalize: (value) => {
        if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.executors)) {
          throw new Error('Invalid executor configuration');
        }
        const executors = value.executors.map(parseStoredExecutor);
        assertUniqueExecutors(executors);
        return executors;
      },
    });
  }

  list(): readonly RemoteExecutorConfig[] { return structuredClone(this.#executors); }

  get(id: string): RemoteExecutorConfig | null {
    const executor = this.#executors.find((entry) => entry.id === id);
    return executor ? structuredClone(executor) : null;
  }

  require(id: string): RemoteExecutorConfig {
    const executor = this.get(id);
    if (!executor) throw new DomainError('EXECUTOR_NOT_FOUND', 'Executor not found', 404);
    return executor;
  }

  connection(id: string) {
    const executor = this.require(id);
    return {
      connectionUrl: executorConnectionUrl(executor.connection.kind === 'executor-connects' ? executor.connection.advertisedUrl : executor.connection.targetUrl, executor.secret),
      allowInsecureDevelopment: executor.allowInsecureDevelopment,
      allowUnverifiedTls: executor.allowUnverifiedTls,
    };
  }

  create(input: CreateExecutorRequest): Promise<RemoteExecutorConfig> {
    return this.#serialize(async () => {
      const request = parseCreateExecutorRequest(input);
      if (!request) throw new ValidationDomainError('Invalid executor configuration');
      const id = randomUUID();
      const allowInsecureDevelopment = request.allowInsecureDevelopment ?? false;
      const parsed = request.direction === 'controller-connects' ? parseConnectionUrl(request.connectionUrl) : null;
      const executor: RemoteExecutorConfig = {
        id, label: request.label, enabled: true, allowInsecureDevelopment,
        allowControllerCli: request.allowControllerCli ?? false,
        allowUnverifiedTls: parsed?.socketUrl.startsWith('wss:') === true && request.allowUnverifiedTls === true,
        secret: parsed?.secret ?? createExecutorSecret(),
        connection: parsed
          ? { kind: 'controller-connects', targetUrl: validateExecutorSocketUrl(parsed.socketUrl, { direction: 'controller-connects', allowInsecureDevelopment }) }
          : { kind: 'executor-connects', advertisedUrl: `wss://example.com/executor/${id}` },
      };
      await this.#save([...this.#executors, executor]);
      return structuredClone(executor);
    });
  }

  update(id: string, input: UpdateExecutorRequest): Promise<RemoteExecutorConfig> {
    return this.#serialize(async () => {
      const request = parseUpdateExecutorRequest(input);
      if (!request) throw new ValidationDomainError('Invalid executor update');
      const previous = this.require(id);
      let executor: RemoteExecutorConfig = {
        ...previous,
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        ...(request.allowControllerCli === undefined ? {} : { allowControllerCli: request.allowControllerCli }),
      };
      if (request.connection) {
        const { direction, connectionUrl, allowInsecureDevelopment } = request.connection;
        const parsed = parseConnectionUrl(connectionUrl);
        const socketUrl = validateExecutorSocketUrl(parsed.socketUrl, { direction, allowInsecureDevelopment, executorId: id });
        executor = {
          ...executor, secret: parsed.secret, allowInsecureDevelopment,
          allowUnverifiedTls: direction === 'controller-connects' && socketUrl.startsWith('wss:') && request.connection.allowUnverifiedTls === true,
          connection: direction === 'executor-connects' ? { kind: direction, advertisedUrl: socketUrl } : { kind: direction, targetUrl: socketUrl },
        };
      }
      await this.#save(this.#executors.map((entry) => entry.id === id ? executor : entry));
      return structuredClone(executor);
    });
  }

  remove(id: string): Promise<void> {
    return this.#serialize(async () => {
      this.require(id);
      await this.#save(this.#executors.filter((entry) => entry.id !== id));
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation);
    this.#pending = result.catch(() => undefined);
    return result;
  }

  async #save(executors: readonly RemoteExecutorConfig[]): Promise<void> {
    assertUniqueExecutors(executors);
    try {
      await writeJsonFileAtomic(this.#path, { version: 1, executors }, { mode: 0o600 });
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) this.#executors = executors;
      throw error;
    }
    this.#executors = executors;
  }
}

function parseStoredExecutor(value: unknown): RemoteExecutorConfig {
  if (!isRecord(value) || !isRemoteExecutorId(value.id) || typeof value.label !== 'string'
    || !value.label.trim() || value.label.length > 100 || typeof value.enabled !== 'boolean'
    || !isExecutorSecret(value.secret) || typeof value.allowInsecureDevelopment !== 'boolean'
    || value.allowControllerCli !== undefined && typeof value.allowControllerCli !== 'boolean'
    || value.allowUnverifiedTls !== undefined && typeof value.allowUnverifiedTls !== 'boolean'
    || !isRecord(value.connection)) throw new Error('Invalid executor configuration');
  const options = { executorId: value.id, allowInsecureDevelopment: value.allowInsecureDevelopment };
  const connection = value.connection.kind === 'executor-connects' && typeof value.connection.advertisedUrl === 'string'
    ? { kind: 'executor-connects' as const, advertisedUrl: validateExecutorSocketUrl(value.connection.advertisedUrl, { ...options, direction: 'executor-connects' }) }
    : value.connection.kind === 'controller-connects' && typeof value.connection.targetUrl === 'string'
      ? { kind: 'controller-connects' as const, targetUrl: validateExecutorSocketUrl(value.connection.targetUrl, { ...options, direction: 'controller-connects' }) }
      : null;
  if (!connection || connection.kind === 'executor-connects' && value.allowUnverifiedTls === true) throw new Error('Invalid executor connection configuration');
  return { id: value.id, label: value.label, enabled: value.enabled, secret: value.secret, connection,
    allowControllerCli: value.allowControllerCli === true,
    allowInsecureDevelopment: value.allowInsecureDevelopment,
    allowUnverifiedTls: connection.kind === 'controller-connects' && connection.targetUrl.startsWith('wss:') && value.allowUnverifiedTls === true };
}

function assertUniqueExecutors(executors: readonly RemoteExecutorConfig[]): void {
  if (new Set(executors.map((executor) => executor.id)).size !== executors.length || new Set(executors.map((executor) => executor.secret)).size !== executors.length) {
    throw new ValidationDomainError('Executors must have unique IDs and shared secrets');
  }
}
