export interface ChatTranscriptSourceDto {
  readonly kind: 'filesystem-path' | 'provider-reference';
  readonly value: string;
}

export interface ChatCarryOverHandoffDto {
  readonly agentId: string;
  readonly model: string;
}

export interface ChatCarryOverSegmentDto {
  readonly id: string;
  readonly agentId: string;
  readonly model: string;
  readonly capturedAt: string;
  readonly storedMessageCount: number;
  readonly visibleMessageCount: number;
  readonly truncated: boolean;
  readonly trailingHandoff: ChatCarryOverHandoffDto | null;
}

export interface ChatCarryOverDetailsDto {
  readonly revision: string;
  readonly archivedMessageCount: number;
  readonly segments: readonly ChatCarryOverSegmentDto[];
}

export interface ChatDetailsResponse {
  readonly chatId: string;
  readonly firstMessage: string;
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly agentSessionId: string | null;
  readonly transcriptSource: ChatTranscriptSourceDto | null;
  readonly carryOver: ChatCarryOverDetailsDto;
}
