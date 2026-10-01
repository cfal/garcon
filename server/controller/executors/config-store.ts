import { randomUUID } from 'node:crypto';
import { assertPrivateFile } from '../../common/private-file.js';
import { join } from 'node:path';
import {
  isRemoteExecutorId, LOCAL_EXECUTOR_LABEL, parseCreateExecutorRequest, parseUpdateExecutorRequest,
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
  readonly allowExecutorManagement: boolean;
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
      this.#assertLabelAvailable(request.label);
      const id = randomUUID();
      const allowInsecureDevelopment = request.allowInsecureDevelopment ?? false;
      const parsed = request.direction === 'controller-connects' ? parseConnectionUrl(request.connectionUrl) : null;
      const executor: RemoteExecutorConfig = {
        id, label: request.label, enabled: true, allowInsecureDevelopment,
        allowControllerCli: request.allowControllerCli ?? false,
        allowExecutorManagement: request.allowExecutorManagement ?? false,
        allowUnverifiedTls: parsed?.socketUrl.startsWith('wss:') === true && request.allowUnverifiedTls === true,
        secret: parsed?.secret ?? createExecutorSecret(),
        connection: parsed
          ? { kind: 'controller-connects', targetUrl: validateExecutorSocketUrl(parsed.socketUrl, { allowInsecureDevelopment }) }
          : { kind: 'executor-connects', advertisedUrl: validateExecutorSocketUrl(
            request.direction === 'executor-connects' && request.advertisedUrl !== undefined
              ? request.advertisedUrl.replaceAll('{executorId}', id) : `wss://example.com/executor/${id}`,
            { allowInsecureDevelopment },
          ) },
      };
      assertConnectionLength(executor);
      await this.#save([...this.#executors, executor]);
      return structuredClone(executor);
    });
  }

  update(
    id: string, input: UpdateExecutorRequest,
    assertUpdateAllowed?: (previous: RemoteExecutorConfig, next: RemoteExecutorConfig) => void,
  ): Promise<RemoteExecutorConfig> {
    return this.#serialize(async () => {
      const request = parseUpdateExecutorRequest(input);
      if (!request) throw new ValidationDomainError('Invalid executor update');
      const previous = this.require(id);
      if (request.label !== undefined && request.label !== previous.label.trim()) this.#assertLabelAvailable(request.label, id);
      let executor: RemoteExecutorConfig = {
        ...previous,
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        ...(request.allowControllerCli === undefined ? {} : { allowControllerCli: request.allowControllerCli }),
        ...(request.allowExecutorManagement === undefined ? {} : { allowExecutorManagement: request.allowExecutorManagement }),
      };
      if (request.connection) {
        const { direction, connectionUrl, allowInsecureDevelopment } = request.connection;
        const parsed = parseConnectionUrl(connectionUrl);
        const socketUrl = validateExecutorSocketUrl(parsed.socketUrl, { allowInsecureDevelopment });
        executor = {
          ...executor, secret: parsed.secret, allowInsecureDevelopment,
          allowUnverifiedTls: direction === 'controller-connects' && socketUrl.startsWith('wss:') && request.connection.allowUnverifiedTls === true,
          connection: direction === 'executor-connects' ? { kind: direction, advertisedUrl: socketUrl } : { kind: direction, targetUrl: socketUrl },
        };
        assertConnectionLength(executor);
      }
      assertUpdateAllowed?.(previous, executor);
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

  #assertLabelAvailable(label: string, executorId?: string): void {
    const normalized = label.trim().toLowerCase();
    if (normalized === LOCAL_EXECUTOR_LABEL.toLowerCase()) {
      throw new ValidationDomainError('The label "Local" is reserved for the local executor');
    }
    if (this.#executors.some((entry) => entry.id !== executorId && entry.label.trim().toLowerCase() === normalized)) {
      throw new ValidationDomainError('An executor with this label already exists (case-insensitive)');
    }
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
    || value.allowExecutorManagement !== undefined && typeof value.allowExecutorManagement !== 'boolean'
    || value.allowUnverifiedTls !== undefined && typeof value.allowUnverifiedTls !== 'boolean'
    || !isRecord(value.connection)) throw new Error('Invalid executor configuration');
  const options = { allowInsecureDevelopment: value.allowInsecureDevelopment };
  const connection = value.connection.kind === 'executor-connects' && typeof value.connection.advertisedUrl === 'string'
    ? { kind: 'executor-connects' as const, advertisedUrl: validateExecutorSocketUrl(value.connection.advertisedUrl, options) }
    : value.connection.kind === 'controller-connects' && typeof value.connection.targetUrl === 'string'
      ? { kind: 'controller-connects' as const, targetUrl: validateExecutorSocketUrl(value.connection.targetUrl, options) }
      : null;
  if (!connection || connection.kind === 'executor-connects' && value.allowUnverifiedTls === true) throw new Error('Invalid executor connection configuration');
  return { id: value.id, label: value.label, enabled: value.enabled, secret: value.secret, connection,
    allowControllerCli: value.allowControllerCli === true,
    allowExecutorManagement: value.allowExecutorManagement === true,
    allowInsecureDevelopment: value.allowInsecureDevelopment,
    allowUnverifiedTls: connection.kind === 'controller-connects' && connection.targetUrl.startsWith('wss:') && value.allowUnverifiedTls === true };
}

function assertConnectionLength(executor: RemoteExecutorConfig): void {
  const address = executor.connection.kind === 'executor-connects' ? executor.connection.advertisedUrl : executor.connection.targetUrl;
  if (executorConnectionUrl(address, executor.secret).length > 4096) {
    throw new ValidationDomainError('Executor connection URL exceeds 4096 characters after address expansion');
  }
}

function assertUniqueExecutors(executors: readonly RemoteExecutorConfig[]): void {
  if (new Set(executors.map((executor) => executor.id)).size !== executors.length || new Set(executors.map((executor) => executor.secret)).size !== executors.length) {
    throw new ValidationDomainError('Executors must have unique IDs and shared secrets');
  }
}
