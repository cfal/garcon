import { createHash, type Hash } from 'node:crypto';
import { stableJsonStringify } from '@garcon/common/json';
import type {
  AgentEventDigest,
  AgentProjectionStateRevision,
  AgentStreamEvent,
  AgentTranscriptEntry,
  AgentTranscriptRevision,
} from '@garcon/server-agent-interface';

const REVISION_VERSION = 'agent-ledger-v1';
const EVENT_VERSION = 'agent-stream-event-v1';

export type AgentStreamEventWithoutDigest = AgentStreamEvent extends infer Event
  ? Event extends AgentStreamEvent
    ? Omit<Event, 'digest'>
    : never
  : never;

export interface OrderedEntryEnvelope {
  readonly ordinal: number;
  readonly id: AgentTranscriptEntry['id'];
  readonly source: AgentTranscriptEntry['source'];
  readonly provenance: AgentTranscriptEntry['provenance'];
  readonly message: AgentTranscriptEntry['message'];
}

export class AgentProjectionRevisionAccumulator {
  readonly #digest: Hash;
  #count = 0;

  constructor() {
    this.#digest = createHash('sha256');
    if (typeof this.#digest.copy !== 'function') {
      throw new Error('The projection revision requires non-finalizing Hash.copy() support');
    }
    this.#digest.update(`${REVISION_VERSION}\0`);
  }

  add(entry: AgentTranscriptEntry, ordinal = this.#count + 1): void {
    if (entry.lifetime !== 'durable') {
      throw new TypeError('Only durable entries participate in the durable revision');
    }
    if (ordinal !== this.#count + 1) {
      throw new TypeError('Durable entries must be accumulated in contiguous ordinal order');
    }
    const serialized = stableJsonStringify(orderedEntryEnvelope(entry, ordinal));
    this.#digest.update(`${Buffer.byteLength(serialized)}:`);
    this.#digest.update(serialized);
    this.#count += 1;
  }

  finish(): AgentTranscriptRevision {
    return `${REVISION_VERSION}:${this.#count}:${this.#digest.copy().digest('hex')}` as AgentTranscriptRevision;
  }

  get count(): number {
    return this.#count;
  }
}

export function orderedEntryEnvelope(
  entry: AgentTranscriptEntry,
  ordinal: number,
): OrderedEntryEnvelope {
  return {
    ordinal,
    id: entry.id,
    source: entry.source,
    provenance: entry.provenance,
    message: entry.message,
  };
}

export function computeProjectionRevisions(entries: readonly AgentTranscriptEntry[]): {
  readonly durableCount: number;
  readonly durableRevision: AgentTranscriptRevision;
  readonly stateRevision: AgentProjectionStateRevision;
} {
  const accumulator = new AgentProjectionRevisionAccumulator();
  let active: OrderedEntryEnvelope | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.lifetime === 'durable') {
      if (active) throw new TypeError('A durable entry cannot follow the active suffix');
      accumulator.add(entry, index + 1);
    } else {
      if (active || index !== entries.length - 1) {
        throw new TypeError('Projection may contain only one trailing active entry');
      }
      active = orderedEntryEnvelope(entry, index + 1);
    }
  }
  const durableRevision = accumulator.finish();
  const stateRevision = createHash('sha256')
    .update(stableJsonStringify({
      version: 'agent-projection-state-v1',
      durableRevision,
      active,
    }))
    .digest('hex') as AgentProjectionStateRevision;
  return {
    durableCount: accumulator.count,
    durableRevision,
    stateRevision,
  };
}

export function computeAgentStreamEventDigest(
  event: AgentStreamEventWithoutDigest | AgentStreamEvent,
): AgentEventDigest {
  const { digest: _digest, ...withoutDigest } = event as AgentStreamEvent;
  return createHash('sha256')
    .update(stableJsonStringify({
      version: EVENT_VERSION,
      event: eventDigestValue(withoutDigest),
    }))
    .digest('hex') as AgentEventDigest;
}

function eventDigestValue(event: AgentStreamEventWithoutDigest): unknown {
  if (event.kind !== 'terminal' || event.outcome.kind !== 'failed') return event;
  const error = event.outcome.error;
  return {
    ...event,
    outcome: {
      kind: 'failed',
      error: {
        name: error.name,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
    },
  };
}
