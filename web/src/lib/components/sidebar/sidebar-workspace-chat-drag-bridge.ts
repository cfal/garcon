import type { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';

type WorkspaceChatDragPort = Pick<
	WorkspaceWindowDndController,
	'payload' | 'beginChatDrag' | 'endDrag'
>;

export class SidebarWorkspaceChatDragBridge {
	constructor(private readonly dnd: WorkspaceChatDragPort) {}

	begin(chatId: string): void {
		this.dnd.beginChatDrag(chatId);
	}

	endIfOwned(chatId: string | null): void {
		if (
			chatId &&
			this.dnd.payload?.kind === 'chat' &&
			this.dnd.payload.chatId === chatId
		) {
			this.dnd.endDrag();
		}
	}
}
