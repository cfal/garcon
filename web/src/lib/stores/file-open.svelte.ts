// Coordinates file-open requests from chat surfaces (markdown links, tool
// renderers) to the FilesPanel. Keyed by chatId to prevent cross-chat
// leakage. Both markdown and tool file-open actions route through this
// single store.

export type FileOpenSource = 'markdown' | 'tool';

export interface FileOpenRequest {
	chatId: string;
	relativePath: string;
	requestedAt: number;
	source: FileOpenSource;
}

export class FileOpenStore {
	/** The current pending request, consumed by FilesPanel. */
	pending = $state<FileOpenRequest | null>(null);

	/** Requests that a file be opened in the Files tab for the given chat. */
	requestOpenFile(chatId: string, relativePath: string, source: FileOpenSource): void {
		this.pending = {
			chatId,
			relativePath,
			requestedAt: Date.now(),
			source,
		};
	}

	/** Consumes the pending request if it matches the given chatId. Returns the request or null. */
	consumeForChat(chatId: string): FileOpenRequest | null {
		if (this.pending && this.pending.chatId === chatId) {
			const req = this.pending;
			this.pending = null;
			return req;
		}
		return null;
	}
}

export function createFileOpenStore(): FileOpenStore {
	return new FileOpenStore();
}
