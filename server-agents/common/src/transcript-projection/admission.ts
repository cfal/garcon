import type {
  AgentInputAdmissionState,
  AgentInputPreparation,
  AgentInputRollbackResult,
  AgentTranscriptAdmissionIdentity,
  AgentTranscriptCommitEvent,
  AgentTranscriptEntry,
  AgentTranscriptEntryId,
  AgentTranscriptResetEvent,
} from '@garcon/server-agent-interface';
import type { UserMessage } from '@garcon/common/chat-types';
import { stableJsonStringify } from '@garcon/common/json';
import { newAgentStreamEpoch, newAgentTranscriptEntryId } from './identity.js';
import type { AgentProjectionEventStream } from './stream.js';

type AdmissionRecord = {
  readonly identity: AgentTranscriptAdmissionIdentity;
  readonly payload: string;
  readonly entry: AgentTranscriptEntry;
  state: 'prepared' | 'rolled-back' | 'committed' | 'discarded';
  commitEvent?: AgentTranscriptCommitEvent;
  discardEvent?: AgentTranscriptResetEvent;
};

export class AgentInputAdmissionCoordinator {
  readonly #records = new Map<string, AdmissionRecord>();

  constructor(private readonly stream: AgentProjectionEventStream) {}

  prepare(
    message: UserMessage,
    operation: AgentTranscriptAdmissionIdentity,
  ): AgentInputPreparation {
    this.#validateOperation(operation);
    const key = admissionKey(operation);
    const payload = stableJsonStringify({ message, operation });
    const existing = this.#records.get(key);
    if (existing) {
      if (existing.payload !== payload) throw new TypeError('Admission identity was reused with different input');
      return this.#preparation(existing);
    }
    if (this.stream.current.entries.at(-1)?.lifetime === 'active') {
      throw new TypeError('A projection may have only one unresolved active admission');
    }
    const entry: AgentTranscriptEntry = {
      id: newAgentTranscriptEntryId(),
      lifetime: 'active',
      source: null,
      provenance: { ...operation, upstreamRequestId: null },
      message,
    };
    const record: AdmissionRecord = { identity: operation, payload, entry, state: 'prepared' };
    this.#records.set(key, record);
    return this.#preparation(record);
  }

  resolve(operation: AgentTranscriptAdmissionIdentity): AgentInputAdmissionState {
    this.#validateOperation(operation);
    const record = this.#records.get(admissionKey(operation));
    if (!record) {
      const stored = this.#findStoredAdmission(operation);
      return stored ? { kind: 'committed-settled', entryId: stored.id } : { kind: 'absent' };
    }
    switch (record.state) {
      case 'prepared': return { kind: 'prepared' };
      case 'rolled-back': return { kind: 'rolled-back' };
      case 'committed': return { kind: 'committed', event: record.commitEvent! };
      case 'discarded': return { kind: 'discarded', event: record.discardEvent! };
    }
  }

  #preparation(record: AdmissionRecord): AgentInputPreparation {
    return {
      commit: async () => {
        if (record.state === 'committed') return record.commitEvent!;
        if (record.state !== 'prepared') throw new TypeError(`Cannot commit ${record.state} admission`);
        const event = await this.stream.commit([], [record.entry]);
        record.commitEvent = event;
        record.state = 'committed';
        return event;
      },
      rollback: async (): Promise<AgentInputRollbackResult> => {
        if (record.state === 'prepared' || record.state === 'rolled-back') {
          record.state = 'rolled-back';
          return { kind: 'rolled-back' };
        }
        return { kind: 'conflict', state: record.state };
      },
      discardCommitted: async () => {
        if (record.state === 'discarded') return record.discardEvent!;
        if (record.state !== 'committed') throw new TypeError('Only committed admission can be discarded');
        const active = this.stream.current.entries.at(-1);
        if (active?.id !== record.entry.id || active.lifetime !== 'active') {
          throw new TypeError('Committed admission is not the active projection suffix');
        }
        const event = await this.stream.reset({
          reason: 'input-not-sent',
          epoch: newAgentStreamEpoch(),
          contentEpoch: this.stream.current.checkpoint.projection.contentEpoch,
          entries: this.stream.current.entries.slice(0, -1),
        });
        record.discardEvent = event;
        record.state = 'discarded';
        return event;
      },
    };
  }

  #findStoredAdmission(operation: AgentTranscriptAdmissionIdentity): AgentTranscriptEntry | undefined {
    return this.stream.current.entries.find((entry) => (
      entry.provenance?.agentOwnershipEpoch === operation.agentOwnershipEpoch
      && entry.provenance.clientRequestId === operation.clientRequestId
    ));
  }

  #validateOperation(operation: AgentTranscriptAdmissionIdentity): void {
    if (!operation.clientRequestId || !operation.turnId || !operation.turnOwner
        || operation.agentOwnershipEpoch !== this.stream.current.agentOwnershipEpoch
        || operation.turnOwner.agentOwnershipEpoch !== operation.agentOwnershipEpoch
        || operation.turnOwner.turnId !== operation.turnId) {
      throw new TypeError('Invalid admission operation identity');
    }
  }
}

function admissionKey(operation: AgentTranscriptAdmissionIdentity): string {
  return `${operation.agentOwnershipEpoch}:${operation.clientRequestId}`;
}

export function findAdmissionEntryId(
  entries: readonly AgentTranscriptEntry[],
  operation: AgentTranscriptAdmissionIdentity,
): AgentTranscriptEntryId | null {
  return entries.find((entry) => (
    entry.provenance?.agentOwnershipEpoch === operation.agentOwnershipEpoch
    && entry.provenance.clientRequestId === operation.clientRequestId
  ))?.id ?? null;
}
