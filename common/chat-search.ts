export type ChatSearchSnippetRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatSearchRequest {
  query: string;
  textTokens?: string[];
  chatIds?: string[];
  limit?: number;
}

export interface ChatSearchSnippet {
  messageOrdinal: number;
  role: ChatSearchSnippetRole;
  timestamp: string | null;
  text: string;
}

export interface ChatSearchResult {
  chatId: string;
  score: number;
  matchedMessageCount: number;
  snippets: ChatSearchSnippet[];
}

export interface ChatSearchIndexStatus {
  indexedChatCount: number;
  pendingChatCount: number;
}

export interface ChatSearchResponse {
  query: string;
  results: ChatSearchResult[];
  total: number;
  index: ChatSearchIndexStatus;
}
