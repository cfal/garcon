import type {
  AgentControlRow,
  AgentProjectionState,
  AgentSegmentIdentity,
  AgentStreamCheckpoint,
  AgentStreamEpoch,
  AgentTranscriptContentEpoch,
  AgentTranscriptEntry,
} from '@garcon/server-agent-interface';
import { agentStreamOffset, sourceIdentityKey } from './identity.js';
import { computeProjectionRevisions } from './revision.js';

export interface AgentProjectionMaterialization extends AgentSegmentIdentity {
  readonly checkpoint: AgentStreamCheckpoint;
  readonly entries: readonly AgentTranscriptEntry[];
  readonly controls: ReadonlyMap<string, AgentControlRow>;
  readonly retiredControlIncarnations: ReadonlySet<string>;
}

export function createProjectionState(
  epoch: AgentStreamEpoch,
  contentEpoch: AgentTranscriptContentEpoch,
  entries: readonly AgentTranscriptEntry[],
): AgentProjectionState {
  validateEntries(entries);
  const revisions = computeProjectionRevisions(entries);
  return {
    epoch,
    contentEpoch,
    total: entries.length,
    durableCount: revisions.durableCount,
    durableRevision: revisions.durableRevision,
    stateRevision: revisions.stateRevision,
  };
}

export function createProjectionMaterialization(options: AgentSegmentIdentity & {
  readonly epoch: AgentStreamEpoch;
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly entries?: readonly AgentTranscriptEntry[];
}): AgentProjectionMaterialization {
  const entries = [...(options.entries ?? [])];
  const projection = createProjectionState(options.epoch, options.contentEpoch, entries);
  return {
    chatId: options.chatId,
    agentOwnershipEpoch: options.agentOwnershipEpoch,
    checkpoint: {
      chatId: options.chatId,
      agentOwnershipEpoch: options.agentOwnershipEpoch,
      offset: agentStreamOffset(0),
      projection,
    },
    entries,
    controls: new Map(),
    retiredControlIncarnations: new Set(),
  };
}

export function controlIdentity(id: string, incarnation: string): string {
  return `${id.length}:${id}${incarnation}`;
}

export function validateEntries(entries: readonly AgentTranscriptEntry[]): void {
  const ids = new Set<string>();
  const sources = new Set<string>();
  let foundActive = false;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!entry.id || ids.has(entry.id)) throw new TypeError('Transcript entry IDs must be unique');
    ids.add(entry.id);
    if (entry.source) {
      const sourceKey = sourceIdentityKey(entry.source);
      if (sources.has(sourceKey)) throw new TypeError('Transcript source identities must be unique');
      sources.add(sourceKey);
    }
    if (entry.lifetime === 'active') {
      if (foundActive || index !== entries.length - 1 || entry.source !== null) {
        throw new TypeError('Only one source-free trailing active entry is allowed');
      }
      foundActive = true;
    } else if (foundActive) {
      throw new TypeError('Durable entries must form a contiguous prefix');
    }
  }
}
