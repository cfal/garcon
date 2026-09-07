import type {
  ChatHandoffArtifactExcludedEntryCount,
} from '../../../common/chat-handoff-artifact-contracts.js';

export interface HandoffArtifactChatMetadata {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly model: string | null;
}

export interface HandoffArtifactAttribute {
  readonly name: string;
  readonly value: string;
}

export interface HandoffArtifactSourceEntry {
  readonly ordinal: number;
  readonly level: number;
  readonly turn: number;
  readonly tag: 'user' | 'assistant' | 'compaction' | 'tool-call' | 'handoff' | 'notice';
  readonly attributes: readonly HandoffArtifactAttribute[];
  readonly body: string | null;
  readonly abridged: boolean;
}

export interface RenderedHandoffArtifactEntry {
  readonly source: HandoffArtifactSourceEntry;
  readonly xml: string;
  readonly abridged: boolean;
}

export interface HandoffArtifactGap {
  readonly afterOrdinal: number | null;
  readonly beforeOrdinal: number | null;
  readonly omittedEligibleEntryCount: number;
}

export type HandoffArtifactDocumentNode =
  | { readonly kind: 'entry'; readonly entry: RenderedHandoffArtifactEntry }
  | { readonly kind: 'gap'; readonly gap: HandoffArtifactGap };

export interface HandoffArtifactSelection {
  readonly nodes: readonly HandoffArtifactDocumentNode[];
  readonly admissionCost: number;
  readonly includedEntryCount: number;
  readonly budgetOmittedEntryCount: number;
  readonly abridgedEntryCount: number;
  readonly gapCount: number;
  readonly projectionTruncated: boolean;
}

export interface HandoffArtifactSourceFold {
  readonly entries: readonly HandoffArtifactSourceEntry[];
  readonly sourceEntryCount: number;
  readonly eligibleEntryCount: number;
  readonly excludedEntryCounts: readonly ChatHandoffArtifactExcludedEntryCount[];
}

export interface RenderedHandoffArtifact {
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
  readonly contextWindowTokens: number;
  readonly usableTokenBudget: number;
  readonly estimatedTokens: number;
  readonly sourceEntryCount: number;
  readonly eligibleEntryCount: number;
  readonly excludedEntryCounts: readonly ChatHandoffArtifactExcludedEntryCount[];
  readonly includedEntryCount: number;
  readonly budgetOmittedEntryCount: number;
  readonly abridgedEntryCount: number;
  readonly gapCount: number;
  readonly projectionTruncated: boolean;
  readonly document: string;
  readonly fitCorrectionPasses: number;
  readonly metadataPasses: number;
}
