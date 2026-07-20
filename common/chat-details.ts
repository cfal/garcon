export interface ChatTranscriptSourceDto {
  readonly kind: 'filesystem-path' | 'provider-reference';
  readonly value: string;
}

export interface ChatDetailsResponse {
  readonly chatId: string;
  readonly firstMessage: string;
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly agentSessionId: string | null;
  readonly transcriptSource: ChatTranscriptSourceDto | null;
}
