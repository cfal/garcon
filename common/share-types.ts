// Shared types for the chat sharing feature.

// Identity of the transcript view copied into the self-contained share.
export interface SharedChatOrigin {
  transcriptViewId: string;
  lastOrdinal: number;
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

// Fields public share readers receive. The owning chat, its project path, and its
// transcript origin stay on the controller.
export type PublicSharedChatSnapshot = Pick<
  SharedChatSnapshot,
  'shareToken' | 'title' | 'agentId' | 'model' | 'sharedAt' | 'messages'
>;

export interface GetSharedChatResponse {
  snapshot: PublicSharedChatSnapshot;
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
