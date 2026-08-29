import { describe, expect, it, vi } from 'vitest';
import { SidebarWorkspaceChatDragBridge } from '../sidebar-workspace-chat-drag-bridge.js';
import type { WorkspaceDragPayload } from '$lib/workspace/window-dnd.svelte.js';

function createBridge() {
	let payload: WorkspaceDragPayload | null = null;
	const beginChatDrag = vi.fn((chatId: string) => {
		payload = { kind: 'chat', chatId, source: 'chat-list' };
	});
	const endDrag = vi.fn(() => {
		payload = null;
	});
	const port = {
		get payload() {
			return payload;
		},
		beginChatDrag,
		endDrag,
	};
	return { bridge: new SidebarWorkspaceChatDragBridge(port), beginChatDrag, endDrag };
}

describe('SidebarWorkspaceChatDragBridge', () => {
	it('starts and ends the matching sidebar chat drag', () => {
		const { bridge, beginChatDrag, endDrag } = createBridge();

		bridge.begin('chat-1');
		bridge.endIfOwned('chat-1');

		expect(beginChatDrag).toHaveBeenCalledWith('chat-1');
		expect(endDrag).toHaveBeenCalledOnce();
	});

	it('leaves another drag owner untouched', () => {
		const { bridge, endDrag } = createBridge();

		bridge.begin('chat-1');
		bridge.endIfOwned('chat-2');
		bridge.endIfOwned(null);

		expect(endDrag).not.toHaveBeenCalled();
	});
});
