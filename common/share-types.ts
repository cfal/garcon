// Shared types for the chat sharing feature.

// Identity of the pinned composite-ledger snapshot a share was captured from.
// Absent only on shares written before capture pinning existed.
export interface SharedChatOrigin {
  contentEpoch: string | null;
  compositeRevision: string;
  durableCount: number;
}

export interface SharedChatSnapshot {
  shareToken: string;
  chatId: string;
  title: string;
  agentId: string;
  model: string;
  projectPath: string;
  sharedAt: string;
  origin?: SharedChatOrigin;
  messages: unknown[];
}

export interface ShareChatResponse {
  success: boolean;
  shareToken: string;
  shareUrl: string;
}

export interface ShareStatusResponse {
  isShared: boolean;
  shareToken?: string;
  shareUrl?: string;
  sharedAt?: string;
}

export interface GetSharedChatResponse {
  snapshot: SharedChatSnapshot;
  page: SharedChatMessagePage;
}

export interface SharedChatMessagePage {
  snapshotVersion: string;
  totalMessages: number;
  start: number;
  end: number;
  nextBefore: number | null;
  reset?: boolean;
}

export interface RevokeShareResponse {
  success: boolean;
}
