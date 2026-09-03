import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  normalizePreambleDefinitionInput,
  type CreatePreambleRequest,
  type Preamble,
  type PreambleDefinitionInput,
  type PreamblesInvalidationReason,
  type PreamblesSnapshot,
  type RemovePreambleRequest,
  type ReorderPreamblesRequest,
  type UpdatePreambleRequest,
} from '../../common/preambles.js';
import { PreambleDomainError } from './errors.js';
import { applicablePreambles } from './matching.js';
import { PreambleProjectPathService } from './project-path-service.js';
import { PreambleStore } from './store.js';
import { preambleCombinedBudgetViolation } from './catalog-budget.js';

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
    const preamble: Preamble = {
      id: this.#newId(),
      ...definition,
      createdAt: now,
      updatedAt: now,
    };
    this.#assertCombinedBudget([...this.snapshot().preambles, preamble]);
    await this.deps.store.create(preamble, request.expectedRevision);
    return this.#changed('created');
  }

  async update(request: UpdatePreambleRequest): Promise<PreamblesSnapshot> {
    const id = request.id.trim();
    if (!id) throw this.#validationError();
    const definition = await this.#definition(request.preamble);
    const candidate = this.snapshot().preambles.map((preamble) => preamble.id === id
      ? { ...preamble, ...definition }
      : preamble);
    this.#assertCombinedBudget(candidate);
    await this.deps.store.update(id, definition, this.#now().toISOString(), request.expectedRevision);
    return this.#changed('updated');
  }

  async remove(request: RemovePreambleRequest): Promise<PreamblesSnapshot> {
    const id = request.id.trim();
    if (!id) throw this.#validationError();
    await this.deps.store.remove(id, request.expectedRevision);
    return this.#changed('removed');
  }

  async reorder(request: ReorderPreamblesRequest): Promise<PreamblesSnapshot> {
    if (!Array.isArray(request.orderedPreambleIds)) throw this.#validationError();
    const byId = new Map(this.snapshot().preambles.map((preamble) => [preamble.id, preamble]));
    const candidate = request.orderedPreambleIds.map((id) => byId.get(id));
    if (candidate.every((entry): entry is Preamble => Boolean(entry))) {
      this.#assertCombinedBudget(candidate);
    }
    await this.deps.store.reorder(request.orderedPreambleIds, request.expectedRevision);
    return this.#changed('reordered');
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

  #assertCombinedBudget(preambles: readonly Preamble[]): void {
    const violation = preambleCombinedBudgetViolation(preambles);
    if (!violation) return;
    const scope = violation.projectPath === null
      ? 'the global scope'
      : violation.projectPath;
    throw new PreambleDomainError(
      'PREAMBLE_COMBINED_LIMIT_EXCEEDED',
      `Combined matching preambles exceed the maximum length at ${scope}`,
      422,
    );
  }

  #changed(reason: PreamblesInvalidationReason): PreamblesSnapshot {
    const snapshot = this.snapshot();
    this.emit('invalidated', reason);
    return snapshot;
  }

  #validationError(): PreambleDomainError {
    return new PreambleDomainError('PREAMBLE_VALIDATION_FAILED', 'Preamble is invalid', 400);
  }

  #newId(): string {
    return (this.deps.newId ?? crypto.randomUUID)();
  }

  #now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
