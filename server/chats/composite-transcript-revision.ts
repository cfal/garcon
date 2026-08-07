export interface CompositeTranscriptRevision {
  readonly carryOver: string;
  readonly native: string;
  readonly agentOwnershipEpoch: string;
}

export function serializeCompositeTranscriptRevision(
  revision: CompositeTranscriptRevision,
): string {
  return JSON.stringify([
    revision.carryOver,
    revision.native,
    revision.agentOwnershipEpoch,
  ]);
}
