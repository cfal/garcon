export type ChatDraftAppendResult = 'appended' | 'duplicate' | 'unavailable';

export interface ChatDraftAppendOptions {
	/** Appends even when the draft already contains the block. */
	allowDuplicate?: boolean;
}

export type ChatDraftAppend = (block: string) => ChatDraftAppendResult;
