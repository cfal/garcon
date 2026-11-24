import { createRandomId } from '$lib/utils/random-id.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types.js';
import {
	chatViewSurfaceId,
	WORKSPACE_WINDOW_RESOURCE_CEILING,
	type DesktopWorkspaceNode,
	type WorkspaceChatTile,
	type WorkspaceLayoutSnapshot,
	type WorkspacePartitionDirection,
} from './surface-types.js';
import {
	SPLIT_MIN_WINDOW_HEIGHT_PX,
	SPLIT_MIN_WINDOW_WIDTH_PX,
	type WorkspaceHostSize,
} from './window-geometry-policy.js';
import { collectWindowNodes } from './window-tree.js';

export function workingChatIdsForTiling(
	chats: readonly Pick<ChatSessionRecord, 'id' | 'activityStatus' | 'isProcessing'>[],
): string[] {
	const waiting: string[] = [];
	const working: string[] = [];
	for (const chat of chats) {
		if (!chat.isProcessing) continue;
		(chat.activityStatus === 'pending-user-action' ? waiting : working).push(chat.id);
	}
	return [...waiting, ...working];
}

export function planChatTiles(
	snapshot: WorkspaceLayoutSnapshot,
	chatIds: readonly string[],
	host: WorkspaceHostSize | null,
): WorkspaceChatTile[][] {
	const maxColumns = Math.floor((host?.width ?? 0) / SPLIT_MIN_WINDOW_WIDTH_PX);
	const maxRows = Math.floor((host?.height ?? 0) / SPLIT_MIN_WINDOW_HEIGHT_PX);
	const capacity = Math.max(1, Math.min(maxRows * maxColumns, WORKSPACE_WINDOW_RESOURCE_CEILING));
	const selected = chatIds.slice(0, capacity);
	if (!selected.length) return [];

	// Maximizes the smaller usable dimension of the tightest tile.
	let rowCount = 1;
	let bestScale = 0;
	for (
		let rows = Math.ceil(selected.length / Math.max(1, maxColumns));
		rows <= Math.min(maxRows, selected.length);
		rows++
	) {
		const columns = Math.ceil(selected.length / rows);
		const scale = Math.min(
			(host?.width ?? 0) / (columns * SPLIT_MIN_WINDOW_WIDTH_PX),
			(host?.height ?? 0) / (rows * SPLIT_MIN_WINDOW_HEIGHT_PX),
		);
		if (scale > bestScale) {
			rowCount = rows;
			bestScale = scale;
		}
	}

	// Keeps mounted chat surfaces in their original windows, including inactive chat tabs.
	const windows = collectWindowNodes(snapshot.desktopRoot);
	const placements = new Map<string, WorkspaceChatTile['windowId']>();
	const unused = windows.filter(({ id }) => {
		const chat = snapshot.surfaces[chatViewSurfaceId(id)];
		if (chat?.type !== 'chat' || !chat.chatId || !selected.includes(chat.chatId)) return true;
		placements.set(chat.chatId, id);
		return false;
	});
	let offset = 0;
	return Array.from({ length: rowCount }, (_, index) => {
		const length =
			Math.floor(selected.length / rowCount) + Number(index < selected.length % rowCount);
		const row = selected.slice(offset, offset + length);
		offset += length;
		return row.map((chatId) => ({
			chatId,
			windowId: placements.get(chatId) ?? unused.shift()?.id ?? `window-${createRandomId()}`,
		}));
	});
}

// Splitting groups in half keeps even wide grids within the partition ratio and restore-depth bounds.
export function evenlyPartition(
	nodes: readonly DesktopWorkspaceNode[],
	direction: WorkspacePartitionDirection,
): DesktopWorkspaceNode {
	if (!nodes.length) throw new Error('A workspace tile group cannot be empty');
	if (nodes.length === 1) return nodes[0];
	const middle = Math.ceil(nodes.length / 2);
	return {
		type: 'partition',
		id: `partition-tile-${direction}-${nodes[middle].id}`,
		direction,
		ratio: middle / nodes.length,
		children: [
			evenlyPartition(nodes.slice(0, middle), direction),
			evenlyPartition(nodes.slice(middle), direction),
		],
	};
}
