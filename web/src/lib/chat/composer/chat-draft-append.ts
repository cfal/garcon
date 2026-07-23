export type ChatDraftAppendResult = 'appended' | 'duplicate' | 'unavailable';

export type ChatDraftAppend = (block: string) => ChatDraftAppendResult;
