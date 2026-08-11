import type {
  AgentProjectionState,
  AgentTranscriptEntry,
  AgentTranscriptPageResultV4,
} from '@garcon/server-agent-interface';
import { sameProjectionState } from './identity.js';

interface RetainedProjection {
  readonly projection: AgentProjectionState;
  readonly entries: readonly AgentTranscriptEntry[];
}

export class AgentProjectionPager {
  readonly #retained = new Map<string, RetainedProjection>();
  readonly #order: string[] = [];

  constructor(private readonly maxRetainedStates = 8) {}

  retain(projection: AgentProjectionState, entries: readonly AgentTranscriptEntry[]): void {
    const key = projection.stateRevision;
    if (!this.#retained.has(key)) this.#order.push(key);
    this.#retained.set(key, { projection, entries: [...entries] });
    while (this.#order.length > this.maxRetainedStates) {
      const evicted = this.#order.shift();
      if (evicted) this.#retained.delete(evicted);
    }
  }

  page(options: {
    readonly current: AgentProjectionState;
    readonly entries: readonly AgentTranscriptEntry[];
    readonly expected: AgentProjectionState | null;
    readonly beforeOrdinal: number | null;
    readonly limit: number;
  }): AgentTranscriptPageResultV4 {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new TypeError('Transcript page limit must be a positive safe integer');
    }
    this.retain(options.current, options.entries);
    const retained = options.expected
      ? this.#retained.get(options.expected.stateRevision)
      : this.#retained.get(options.current.stateRevision);
    if (!retained || (options.expected && !sameProjectionState(retained.projection, options.expected))) {
      return { kind: 'expired', current: options.current };
    }
    const before = options.beforeOrdinal ?? retained.entries.length + 1;
    if (!Number.isSafeInteger(before) || before < 1 || before > retained.entries.length + 1) {
      throw new TypeError('Transcript page ordinal is outside the projection');
    }
    const end = before - 1;
    const start = Math.max(0, end - options.limit);
    return {
      kind: 'ready',
      page: {
        projection: retained.projection,
        entries: retained.entries.slice(start, end),
        firstOrdinal: start + 1,
        hasMore: start > 0,
      },
    };
  }
}
