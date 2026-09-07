import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  isPreambleId,
  normalizePreambleDefinitionInput,
  PREAMBLE_ID_LIFETIME_MAX_COUNT,
  PREAMBLE_MAX_COUNT,
  type CreatePreambleRequest,
  type Preamble,
  type PreambleDefinitionInput,
  type PreamblesInvalidationReason,
  type PreamblesSnapshot,
  type RemovePreambleRequest,
  type ReorderPreamblesRequest,
  type UpdatePreambleRequest,
} from '../../common/preambles.js';
import { PreambleCatalogCommittedUnknownError, PreambleStore } from './store.js';
import { PreambleDomainError } from './errors.js';
import { applicablePreambles } from './matching.js';
import { PreambleProjectPathService } from './project-path-service.js';

interface PreambleServiceEvents {
  invalidated: [reason: PreamblesInvalidationReason];
}

export class PreambleService extends EventEmitter<PreambleServiceEvents> {
  constructor(private readonly deps: {
    readonly store: PreambleStore;
    readonly projectPaths: Pick<PreambleProjectPathService, 'resolve'>;
    readonly newId?: () => string;
    readonly now?: () => Date;
  }) {
    super();
  }

  onInvalidated(callback: (reason: PreamblesInvalidationReason) => void): void {
    this.on('invalidated', callback);
  }

  snapshot(): PreamblesSnapshot {
    return this.deps.store.snapshot();
  }

  resolve(canonicalProjectPath: string): readonly Preamble[] {
    return applicablePreambles(this.snapshot().preambles, canonicalProjectPath);
  }

  async create(request: CreatePreambleRequest): Promise<PreamblesSnapshot> {
    const definition = await this.#definition(request.preamble);
    const now = this.#now().toISOString();
    return this.#mutate(
      'created',
      () => this.deps.store.createWithGeneratedId(
        request.expectedRevision,
        this.deps.newId ?? (() => crypto.randomUUID()),
        (id) => ({ id, ...definition, createdAt: now, updatedAt: now }),
      ),
    );
  }

  async update(request: UpdatePreambleRequest): Promise<PreamblesSnapshot> {
    // No trim or case folding: the canonical lowercase UUID-v4 spelling only.
    const id = request.id;
    if (!isPreambleId(id)) throw this.#validationError();
    const definition = await this.#definition(request.preamble);
    return this.#mutate(
      'updated',
      () => this.deps.store.update(id, definition, this.#now().toISOString(), request.expectedRevision),
    );
  }

  async remove(request: RemovePreambleRequest): Promise<PreamblesSnapshot> {
    const id = request.id;
    if (!isPreambleId(id)) throw this.#validationError();
    return this.#mutate('removed', () => this.deps.store.remove(id, request.expectedRevision));
  }

  async reorder(request: ReorderPreamblesRequest): Promise<PreamblesSnapshot> {
    if (
      !Array.isArray(request.orderedPreambleIds)
      || request.orderedPreambleIds.length > PREAMBLE_MAX_COUNT
      || !request.orderedPreambleIds.every((id): id is string => isPreambleId(id))
      || new Set(request.orderedPreambleIds).size !== request.orderedPreambleIds.length
    ) throw this.#validationError();
    return this.#mutate('reordered', () =>
      this.deps.store.reorder(request.orderedPreambleIds, request.expectedRevision));
  }

  // A post-rename failure leaves the installed candidate authoritative, so its
  // invalidation is emitted before the unknown-durability outcome surfaces.
  async #mutate(
    reason: PreamblesInvalidationReason,
    run: () => Promise<void>,
  ): Promise<PreamblesSnapshot> {
    try {
      await run();
    } catch (error) {
      if (error instanceof PreambleCatalogCommittedUnknownError) {
        this.emit('invalidated', reason);
        throw new PreambleDomainError(
          'PREAMBLE_CATALOG_SAVE_UNKNOWN',
          'The preambles catalog was saved, but its durability could not be confirmed. Restart the server before further catalog changes.',
          503,
          false,
        );
      }
      throw error;
    }
    return this.#changed(reason);
  }

  async #definition(value: unknown): Promise<PreambleDefinitionInput> {
    const definition = normalizePreambleDefinitionInput(value);
    if (!definition) throw this.#validationError();
    if (definition.scope.type === 'global') return definition;
    const canonical = await Promise.all(definition.scope.rules.map(async (rule) => ({
      projectPath: await this.deps.projectPaths.resolve(rule.projectPath),
      includeNested: rule.includeNested,
    })));
    if (new Set(canonical.map((rule) => rule.projectPath)).size !== canonical.length) {
      throw new PreambleDomainError(
        'PREAMBLE_VALIDATION_FAILED',
        'Project paths must be unique',
        400,
      );
    }
    return { ...definition, scope: { type: 'project-paths', rules: canonical } };
  }

  #changed(reason: PreamblesInvalidationReason): PreamblesSnapshot {
    const snapshot = this.snapshot();
    this.emit('invalidated', reason);
    return snapshot;
  }

  #validationError(): PreambleDomainError {
    return new PreambleDomainError('PREAMBLE_VALIDATION_FAILED', 'Preamble is invalid', 400);
  }

  #now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
