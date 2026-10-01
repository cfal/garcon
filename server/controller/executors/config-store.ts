import { randomUUID } from 'node:crypto';
import { assertPrivateFile } from '../../common/private-file.js';
import { join } from 'node:path';
import {
  isRemoteExecutorId, LOCAL_EXECUTOR_LABEL, parseCreateExecutorRequest, parseUpdateExecutorRequest,
  type CreateExecutorRequest, type UpdateExecutorRequest,
} from '../../../common/executors.js';
import { isRecord } from '../../../common/json.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { AtomicJsonWriteError, CorruptStateFileError, readJsonStateFile, writeJsonFileAtomic } from '../../common/json-file-store.js';
import { createExecutorSecret, isExecutorSecret, executorConnectionUrl, parseConnectionUrl, validateExecutorSocketUrl } from '../../remote/transport/connection-url.js';
import { executorPublicUrl } from './public-url.js';

class ExecutorConfigUpgradeError extends Error {}

export interface RemoteExecutorConfig {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly allowControllerCli: boolean;
  readonly allowExecutorManagement: boolean;
  readonly secret: string;
  readonly connection:
    | { readonly kind: 'executor-connects'; readonly advertisedUrl: string | null }
    | { readonly kind: 'controller-connects'; readonly targetUrl: string };
  readonly noTls: boolean;
  readonly allowUnverifiedTls: boolean;
}

export class ExecutorConfigStore {
  readonly #path: string;
  #executors: readonly RemoteExecutorConfig[] = [];
  #pending: Promise<unknown> = Promise.resolve();
  #uncertainExecutorId: string | null = null;

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
    }).catch((error: unknown) => {
      if (error instanceof CorruptStateFileError && error.cause instanceof ExecutorConfigUpgradeError) {
        throw new ExecutorConfigUpgradeError(`${error.cause.message} Update a copy of ${error.quarantinePath ?? this.#path} and restore it to ${this.#path} before restarting; keep the original backup.`, { cause: error });
      }
      throw error;
    });
    this.#uncertainExecutorId = null;
  }

  list(): readonly RemoteExecutorConfig[] { return structuredClone(this.#executors); }

  isDurable(id: string): boolean { return this.#uncertainExecutorId !== id; }

  get(id: string): RemoteExecutorConfig | null {
    const executor = this.#executors.find((entry) => entry.id === id);
    return executor ? structuredClone(executor) : null;
  }

  require(id: string): RemoteExecutorConfig {
    if (!this.isDurable(id)) throw this.#unavailable();
    const executor = this.get(id);
    if (!executor) throw new DomainError('EXECUTOR_NOT_FOUND', 'Executor not found', 404);
    return executor;
  }

  connection(id: string, publicBase?: string) {
    const executor = this.require(id);
    return {
      connectionUrl: resolveConnectionUrl(executor, publicBase),
      noTls: executor.noTls,
      allowUnverifiedTls: executor.allowUnverifiedTls,
    };
  }

  create(input: CreateExecutorRequest, publicBase?: string): Promise<RemoteExecutorConfig> {
    return this.#serialize(async () => {
      const request = parseCreateExecutorRequest(input);
      if (!request) throw new ValidationDomainError('Invalid executor configuration');
      this.#assertLabelAvailable(request.label);
      const id = randomUUID();
      const noTls = request.noTls ?? false;
      const parsed = request.direction === 'controller-connects' ? parseConnectionUrl(request.connectionUrl) : null;
      let advertisedUrl: string | null = null;
      if (request.direction === 'executor-connects' && request.advertisedUrl !== undefined) {
        advertisedUrl = validateExecutorSocketUrl(request.advertisedUrl.replaceAll('{executorId}', id), { noTls });
      }
      const executor: RemoteExecutorConfig = {
        id, label: request.label, enabled: true, noTls,
        allowControllerCli: request.allowControllerCli ?? false,
        allowExecutorManagement: request.allowExecutorManagement ?? false,
        allowUnverifiedTls: parsed?.socketUrl.startsWith('wss:') === true && request.allowUnverifiedTls === true,
        secret: parsed?.secret ?? createExecutorSecret(),
        connection: parsed
          ? { kind: 'controller-connects', targetUrl: validateExecutorSocketUrl(parsed.socketUrl, { noTls }) }
          : { kind: 'executor-connects', advertisedUrl },
      };
      resolveConnectionUrl(executor, publicBase);
      await this.#save([...this.#executors, executor], id);
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
        const { direction, connectionUrl, noTls } = request.connection;
        if (connectionUrl === undefined && direction !== previous.connection.kind) {
          throw new ValidationDomainError('Changing connection direction requires a connection URL');
        }
        const parsed = connectionUrl === undefined ? null : parseConnectionUrl(connectionUrl);
        const previousSocketUrl = previous.connection.kind === 'controller-connects'
          ? previous.connection.targetUrl : previous.connection.advertisedUrl;
        const socketUrl = parsed?.socketUrl ?? previousSocketUrl;
        const address = socketUrl === null ? null : validateExecutorSocketUrl(socketUrl, { noTls });
        executor = {
          ...executor, secret: parsed?.secret ?? previous.secret, noTls,
          allowUnverifiedTls: direction === 'controller-connects' && address?.startsWith('wss:') === true && request.connection.allowUnverifiedTls === true,
          connection: direction === 'executor-connects' ? { kind: direction, advertisedUrl: address } : { kind: direction, targetUrl: address! },
        };
        resolveConnectionUrl(executor);
      }
      assertUpdateAllowed?.(previous, executor);
      await this.#save(this.#executors.map((entry) => entry.id === id ? executor : entry), id);
      return structuredClone(executor);
    });
  }

  remove(id: string): Promise<void> {
    return this.#serialize(async () => {
      this.require(id);
      await this.#save(this.#executors.filter((entry) => entry.id !== id), id);
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(() => {
      if (this.#uncertainExecutorId !== null) throw this.#unavailable();
      return operation();
    });
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

  #unavailable(): DomainError {
    return new DomainError('EXECUTOR_UNAVAILABLE', 'Executor configuration durability is unknown. Restart the controller before changing executors.', 503);
  }

  async #save(executors: readonly RemoteExecutorConfig[], executorId: string): Promise<void> {
    assertUniqueExecutors(executors);
    try {
      await writeJsonFileAtomic(this.#path, { version: 1, executors }, { mode: 0o600 });
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        // Retains the file's candidate for references without publishing its authority.
        this.#executors = executors;
        this.#uncertainExecutorId = executorId;
      }
      throw error;
    }
    this.#executors = executors;
  }
}

function parseStoredExecutor(value: unknown): RemoteExecutorConfig {
  if (isRecord(value) && 'allowInsecureDevelopment' in value) {
    throw new ExecutorConfigUpgradeError('Executor configuration uses retired allowInsecureDevelopment; rename it to noTls, preserving its boolean value.');
  }
  if (!isRecord(value) || !isRemoteExecutorId(value.id) || typeof value.label !== 'string'
    || !value.label.trim() || value.label.length > 100 || typeof value.enabled !== 'boolean'
    || !isExecutorSecret(value.secret) || typeof value.noTls !== 'boolean'
    || value.allowControllerCli !== undefined && typeof value.allowControllerCli !== 'boolean'
    || value.allowExecutorManagement !== undefined && typeof value.allowExecutorManagement !== 'boolean'
    || value.allowUnverifiedTls !== undefined && typeof value.allowUnverifiedTls !== 'boolean'
    || !isRecord(value.connection)) throw new Error('Invalid executor configuration');
  const options = { noTls: value.noTls };
  const stored = value.connection;
  let connection: RemoteExecutorConfig['connection'];
  if (stored.kind === 'executor-connects' && (stored.advertisedUrl === null || typeof stored.advertisedUrl === 'string')) {
    connection = {
      kind: 'executor-connects',
      advertisedUrl: stored.advertisedUrl === null ? null : validateExecutorSocketUrl(stored.advertisedUrl, options),
    };
  } else if (stored.kind === 'controller-connects' && typeof stored.targetUrl === 'string') {
    connection = { kind: 'controller-connects', targetUrl: validateExecutorSocketUrl(stored.targetUrl, options) };
  } else {
    throw new Error('Invalid executor connection configuration');
  }
  if (connection.kind === 'executor-connects' && value.allowUnverifiedTls === true) throw new Error('Invalid executor connection configuration');
  return { id: value.id, label: value.label, enabled: value.enabled, secret: value.secret, connection,
    allowControllerCli: value.allowControllerCli === true,
    allowExecutorManagement: value.allowExecutorManagement === true,
    noTls: value.noTls,
    allowUnverifiedTls: connection.kind === 'controller-connects' && connection.targetUrl.startsWith('wss:') && value.allowUnverifiedTls === true };
}

function resolveConnectionUrl(executor: RemoteExecutorConfig, publicBase?: string): string {
  const { connection } = executor;
  let address = connection.kind === 'executor-connects' ? connection.advertisedUrl : connection.targetUrl;
  if (address === null && publicBase) address = executorPublicUrl(publicBase, executor.id);
  if (address === null) return '';
  const url = executorConnectionUrl(address, executor.secret);
  if (url.length > 4096) {
    throw new ValidationDomainError('Executor connection URL exceeds 4096 characters after address expansion');
  }
  return url;
}

function assertUniqueExecutors(executors: readonly RemoteExecutorConfig[]): void {
  if (new Set(executors.map((executor) => executor.id)).size !== executors.length || new Set(executors.map((executor) => executor.secret)).size !== executors.length) {
    throw new ValidationDomainError('Executors must have unique IDs and shared secrets');
  }
}
