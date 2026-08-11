import type {
  AgentOwnershipEpoch,
  AgentTranscriptIndexCheckpointV4,
  AgentTranscriptIndexEntryV4,
  AgentTranscriptIndexOpenResultV4,
  AgentTranscriptIndexSourceRefV4,
  AgentTranscriptIndexSourceV4,
} from '@garcon/server-agent-interface';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import { AgentProjectionJournal } from './journal.js';
import { computeProjectionRevisions } from './revision.js';

export class JournalTranscriptIndexSource implements AgentTranscriptIndexSourceV4 {
  async open(request: {
    readonly source: AgentTranscriptIndexSourceRefV4;
    readonly previous: AgentTranscriptIndexCheckpointV4 | null;
    readonly signal: AbortSignal;
    readonly maxEntriesPerBatch: number;
  }): Promise<AgentTranscriptIndexOpenResultV4> {
    request.signal.throwIfAborted();
    if (!Number.isSafeInteger(request.maxEntriesPerBatch) || request.maxEntriesPerBatch < 1) {
      throw new TypeError('Index batch size must be a positive safe integer');
    }
    const directory = request.source.value.directory;
    if (typeof directory !== 'string' || !directory) {
      return { kind: 'degraded', errorCode: 'SOURCE_INVALID', retryable: false };
    }
    const checkpoint = request.source.checkpoint;
    const journal = await AgentProjectionJournal.open({
      directory,
      chatId: checkpoint.chatId,
      agentOwnershipEpoch: checkpoint.agentOwnershipEpoch,
    });
    request.signal.throwIfAborted();
    const state = journal.state;
    if (state.contentEpoch !== checkpoint.contentEpoch
        || state.entries.length < checkpoint.durableCount
        || computeProjectionRevisions(state.entries.slice(0, checkpoint.durableCount)).durableRevision
          !== checkpoint.durableRevision) {
      return {
        kind: 'expired',
        checkpoint: journal.indexSource(request.source.ownerId).checkpoint,
      };
    }
    const targetEntries = state.entries.slice(0, checkpoint.durableCount);
    if (request.previous
        && sameIndexCheckpoint(request.previous, checkpoint)) {
      return { kind: 'unchanged', checkpoint };
    }
    if (request.previous
        && request.previous.chatId === checkpoint.chatId
        && request.previous.agentOwnershipEpoch === checkpoint.agentOwnershipEpoch
        && request.previous.contentEpoch === checkpoint.contentEpoch
        && request.previous.durableCount <= checkpoint.durableCount
        && computeProjectionRevisions(targetEntries.slice(0, request.previous.durableCount)).durableRevision
          === request.previous.durableRevision) {
      return {
        kind: 'append',
        previous: request.previous,
        checkpoint,
        batches: batches(targetEntries, request.previous.durableCount, request.maxEntriesPerBatch),
      };
    }
    return {
      kind: 'snapshot',
      checkpoint,
      batches: batches(targetEntries, 0, request.maxEntriesPerBatch),
    };
  }

  async close(): Promise<void> {}
}

async function* batches(
  entries: readonly import('@garcon/server-agent-interface').AgentTranscriptEntry[],
  start: number,
  batchSize: number,
): AsyncIterable<readonly AgentTranscriptIndexEntryV4[]> {
  for (let index = start; index < entries.length; index += batchSize) {
    yield entries.slice(index, index + batchSize).map((entry, offset) => ({
      ordinal: index + offset + 1,
      entry: entry as import('@garcon/server-agent-interface').AgentTranscriptEntry & {
        readonly lifetime: 'durable';
      },
    }));
  }
}

function sameIndexCheckpoint(
  left: AgentTranscriptIndexCheckpointV4,
  right: AgentTranscriptIndexCheckpointV4,
): boolean {
  return left.chatId === right.chatId
    && left.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.contentEpoch === right.contentEpoch
    && left.durableCount === right.durableCount
    && left.durableRevision === right.durableRevision;
}
