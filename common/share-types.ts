// Shared types for the chat sharing feature.

export interface SharedChatSnapshot {
  shareToken: string;
  chatId: string;
  title: string;
  provider: string;
  model: string;
  projectPath: string;
  sharedAt: string;
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
}

export interface RevokeShareResponse {
  success: boolean;
}
