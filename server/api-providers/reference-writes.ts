import { DomainError } from '../lib/domain-error.js';
import { AtomicJsonWriteError } from '../lib/json-file-store.js';

type ProviderIds = readonly (string | null | undefined)[];
export type RetainProviderReferences = (next: ProviderIds, current?: ProviderIds) => () => void;

function providerIdSet(values: ProviderIds): Set<string> {
  return new Set(values.filter((id): id is string => Boolean(id)));
}

export class ApiProviderReferenceWrites {
  readonly #writers = new Map<string, number>();
  readonly #deleting = new Set<string>();
  constructor(private readonly exists: (id: string) => boolean) {}

  retain: RetainProviderReferences = (next, current = []) => {
    const previous = providerIdSet(current);
    const references = providerIdSet(next);
    for (const id of references) {
      if (!previous.has(id) && (this.#deleting.has(id) || !this.exists(id))) {
        throw new DomainError('API_PROVIDER_UNAVAILABLE', 'Provider is unavailable for new saved selections.', 409);
      }
    }
    for (const id of previous) references.add(id);
    for (const id of references) {
      this.#writers.set(id, (this.#writers.get(id) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of references) {
        const count = this.#writers.get(id)! - 1;
        if (count) {
          this.#writers.set(id, count);
        } else {
          this.#writers.delete(id);
        }
      }
    };
  };

  deleting(id: string, isReferenced: () => boolean): () => void {
    if (this.#writers.has(id) || isReferenced()) {
      throw new DomainError('API_PROVIDER_IN_USE', 'This provider is used by saved selections or a pending save in this workspace.', 409);
    }
    this.#deleting.add(id);
    return () => {
      this.#deleting.delete(id);
    };
  }
}

// Tracks disk references separately from stores that publish or roll back optimistically.
export class ApiProviderDurableReferences {
  #confirmed = new Set<string>();
  readonly #uncertain = new Set<string>();
  constructor(readonly retain?: RetainProviderReferences) {}

  initialize(values: ProviderIds): void {
    this.#confirmed = providerIdSet(values);
    this.#uncertain.clear();
  }

  references(id: string): boolean {
    return this.#confirmed.has(id) || this.#uncertain.has(id);
  }

  async publish<T>(next: ProviderIds, write: () => Promise<T>, inherited: ProviderIds = []): Promise<T> {
    const release = this.retain?.(next, [...this.#confirmed, ...this.#uncertain, ...inherited]);
    try {
      const result = await write();
      this.initialize(next);
      return result;
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        for (const id of providerIdSet(next)) this.#uncertain.add(id);
      }
      throw error;
    } finally {
      release?.();
    }
  }
}
