import type { AgentChatReference } from '@garcon/server-agent-interface';
import type { ResolvedAgentHandoffTarget } from '../agents/agent-handoff-types.js';
import type { TranscriptWatermark } from '../ledger/contracts.js';

export interface LegacyHandoffIntentV5 {
  readonly version: 5;
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly submittedTargetHash: string;
  readonly kind: 'handoff';
  readonly chatId: string;
  readonly phase: 'commit-decided' | 'registry-committed';
  readonly source: { readonly agentId: string; readonly agentOwnershipEpoch: string };
  readonly target: {
    readonly execution: Omit<ResolvedAgentHandoffTarget, 'executionLocation' | 'projectPath'>;
    readonly agentOwnershipEpoch: string;
  };
  readonly watermark: TranscriptWatermark;
  readonly createdAt: string;
}

export interface DeleteIntentV2 {
  readonly version: 2;
  readonly operationId: string;
  readonly kind: 'delete';
  readonly chatId: string;
  readonly phase: 'prepared' | 'registry-removed';
  readonly sourceEpoch: string | null;
  readonly releaseReferences: readonly AgentChatReference[];
  readonly createdAt: string;
}

export interface AgentOwnershipJournalFileV5 {
  readonly version: 5;
  readonly ownershipIntents: readonly (LegacyHandoffIntentV5 | DeleteIntentV2)[];
}

export function emptyOwnershipJournalV5(): AgentOwnershipJournalFileV5 {
  return { version: 5, ownershipIntents: [] };
}
