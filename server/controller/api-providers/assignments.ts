import { join } from 'node:path';
import { isApiProviderId, type ApiProviderAssignments } from '../../../common/api-providers.js';
import { isExecutorId } from '../../../common/executors.js';
import { isRecord } from '../../../common/json.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { AtomicJsonWriteError, readJsonStateFile, writeJsonFileAtomic } from '../../common/json-file-store.js';
import { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { RetainExecutorReferences } from '../executors/reference-writes.js';

const MAX_ASSIGNMENT_EXECUTORS = 1024;
const MAX_PROVIDERS_PER_EXECUTOR = 1024;

interface AssignmentFile extends ApiProviderAssignments {
  version: 1;
}

function parseAssignments(value: unknown): AssignmentFile {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0 || !isRecord(value.assignments)
    || Object.keys(value.assignments).length > MAX_ASSIGNMENT_EXECUTORS) {
    throw new Error('Invalid provider assignments');
  }
  const assignments: Record<string, string[]> = {};
  for (const [executorId, providerIds] of Object.entries(value.assignments)) {
    if (!isExecutorId(executorId) || !Array.isArray(providerIds) || providerIds.length > MAX_PROVIDERS_PER_EXECUTOR
      || !providerIds.every(isApiProviderId) || new Set(providerIds).size !== providerIds.length) {
      throw new Error('Invalid provider assignment');
    }
    assignments[executorId] = [...providerIds];
  }
  return { version: 1, revision: Number(value.revision), assignments };
}

export class ApiProviderAssignmentStore {
  readonly #path: string;
  readonly #lock = new KeyedPromiseLock();
  readonly #listeners = new Set<() => void>();
  #snapshot: AssignmentFile | null = null;

  constructor(workspaceDir: string, private readonly retain: RetainExecutorReferences) {
    this.#path = join(workspaceDir, 'api-provider-assignments.json');
  }

  async migrate(executorIds: readonly string[], providerIds: readonly string[]): Promise<void> {
    const snapshot = await readJsonStateFile({
      filePath: this.#path,
      normalize: parseAssignments,
      empty: () => parseAssignments({
        version: 1,
        revision: 0,
        assignments: Object.fromEntries(executorIds.map((id) => [id, [...providerIds]])),
      }),
    });
    await writeJsonFileAtomic(this.#path, snapshot, { mode: 0o600 });
  }

  async initialize(): Promise<void> {
    this.#snapshot = null;
    this.#snapshot = await readJsonStateFile({
      filePath: this.#path,
      normalize: parseAssignments,
      empty: () => {
        throw new Error('Provider assignments are missing. Restore api-provider-assignments.json.');
      },
    });
  }

  snapshot(): ApiProviderAssignments {
    const { revision, assignments } = this.#current();
    return { revision, assignments: structuredClone(assignments) };
  }

  allows(executorId: string, providerId: string): boolean {
    return this.#current().assignments[executorId]?.includes(providerId) === true;
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  assign(executorId: string, providerId: string): Promise<void> {
    return this.#change(executorId, (snapshot) => {
      const providerIds = snapshot.assignments[executorId] ?? [];
      if (!providerIds.includes(providerId)) {
        snapshot.assignments[executorId] = [...providerIds, providerId];
      }
    });
  }

  unassign(executorId: string, providerId: string): Promise<void> {
    if (!isApiProviderId(providerId)) throw new ValidationDomainError('Invalid provider ID');
    return this.#change(executorId, (snapshot) => {
      snapshot.assignments[executorId] = (snapshot.assignments[executorId] ?? []).filter((id) => id !== providerId);
    });
  }

  removeProvider(providerId: string): Promise<void> {
    return this.#lock.runExclusive('assignments', async () => {
      const snapshot = structuredClone(this.#current());
      for (const executorId of Object.keys(snapshot.assignments)) {
        snapshot.assignments[executorId] = snapshot.assignments[executorId]!.filter((id) => id !== providerId);
      }
      await this.#save(snapshot);
    });
  }

  prune(executorIds: readonly string[]): Promise<void> {
    return this.#lock.runExclusive('assignments', async () => {
      const snapshot = structuredClone(this.#current());
      const keep = new Set(['local', ...executorIds]);
      for (const executorId of Object.keys(snapshot.assignments)) {
        if (!keep.has(executorId)) delete snapshot.assignments[executorId];
      }
      await this.#save(snapshot);
    });
  }

  #change(executorId: string, mutate: (snapshot: AssignmentFile) => void): Promise<void> {
    if (!isExecutorId(executorId)) throw new ValidationDomainError('Invalid executor');
    return this.#lock.runExclusive('assignments', async () => {
      const release = this.retain([executorId]);
      try {
        const snapshot = structuredClone(this.#current());
        mutate(snapshot);
        await this.#save(snapshot);
      } finally {
        release();
      }
    });
  }

  async #save(snapshot: AssignmentFile): Promise<void> {
    if (JSON.stringify(snapshot) === JSON.stringify(this.#current())) return;
    snapshot.revision++;
    parseAssignments(snapshot);
    try {
      await writeJsonFileAtomic(this.#path, snapshot, { mode: 0o600 });
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) this.#snapshot = null;
      throw error;
    }
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #current(): AssignmentFile {
    if (!this.#snapshot) {
      throw new DomainError('API_PROVIDER_STORAGE_UNAVAILABLE', 'Provider assignments are unavailable. Reload the controller after restoring configuration.', 503);
    }
    return this.#snapshot;
  }
}
