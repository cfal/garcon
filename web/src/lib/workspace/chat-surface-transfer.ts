import type { WorkspacePublication } from './workspace-commit.js';
import type { ChatViewSurfaceId } from './surface-types.js';

export interface ChatSurfaceTransfer {
	readonly sourceSurfaceId: ChatViewSurfaceId;
	readonly destinationSurfaceId: ChatViewSurfaceId;
	readonly chatId: string;
}

export interface ChatSurfaceTransferPort {
	prepareChatSurfaceTransfer(transfer: ChatSurfaceTransfer): WorkspacePublication;
}

export function deferredChatSurfaceTransferPublication(
	getPublication: () => WorkspacePublication | null,
): WorkspacePublication {
	return {
		publish: () => getPublication()?.publish(),
		rollback: () => getPublication()?.rollback(),
	};
}
