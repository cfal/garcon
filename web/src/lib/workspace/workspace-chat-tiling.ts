import { createRandomId } from '$lib/utils/random-id.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types.js';
import {
	chatViewSurfaceId,
	WORKSPACE_WINDOW_RESOURCE_CEILING,
	type WorkspaceChatTile,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowId,
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
		if (chat.activityStatus === 'pending-user-action') waiting.push(chat.id);
		else working.push(chat.id);
	}
	return [...waiting, ...working];
}

function fitChatRows(chatIds: readonly string[], host: WorkspaceHostSize | null): string[][] {
	if (!chatIds.length) return [];
	if (!host || host.width < SPLIT_MIN_WINDOW_WIDTH_PX || host.height < SPLIT_MIN_WINDOW_HEIGHT_PX) {
		return [[chatIds[0]]];
	}
	const maxColumns = Math.floor(host.width / SPLIT_MIN_WINDOW_WIDTH_PX);
	const maxRows = Math.floor(host.height / SPLIT_MIN_WINDOW_HEIGHT_PX);
	const count = Math.min(chatIds.length, maxColumns * maxRows, WORKSPACE_WINDOW_RESOURCE_CEILING);

	// Maximizes the smaller dimension relative to its minimum, preferring fewer rows on a tie.
	const minRows = Math.ceil(count / maxColumns);
	let rowCount = minRows;
	let bestScale = 0;
	for (let rows = minRows; rows <= Math.min(count, maxRows); rows++) {
		const columns = Math.ceil(count / rows);
		const scale = Math.min(
			host.width / (columns * SPLIT_MIN_WINDOW_WIDTH_PX),
			host.height / (rows * SPLIT_MIN_WINDOW_HEIGHT_PX),
		);
		if (scale > bestScale) {
			rowCount = rows;
			bestScale = scale;
		}
	}

	const rows: string[][] = [];
	const remaining = chatIds.slice(0, count);
	for (let rowsLeft = rowCount; rowsLeft > 0; rowsLeft--) {
		rows.push(remaining.splice(0, Math.ceil(remaining.length / rowsLeft)));
	}
	return rows;
}

export function planChatTiles(
	snapshot: WorkspaceLayoutSnapshot,
	chatIds: readonly string[],
	host: WorkspaceHostSize | null,
): WorkspaceChatTile[][] {
	const rows = fitChatRows(chatIds, host);
	const selected = new Set(rows.flat());
	const existing = new Map<string, WorkspaceWindowId>();
	const spare: WorkspaceWindowId[] = [];
	// Keeps mounted chat surfaces in their original windows, including inactive chat tabs.
	for (const { id } of collectWindowNodes(snapshot.desktopRoot)) {
		const chat = snapshot.surfaces[chatViewSurfaceId(id)];
		if (chat?.type === 'chat' && chat.chatId && selected.has(chat.chatId)) {
			existing.set(chat.chatId, id);
		} else {
			spare.push(id);
		}
	}
	return rows.map((row) =>
		row.map((chatId) => ({
			chatId,
			windowId: existing.get(chatId) ?? spare.shift() ?? `window-${createRandomId()}`,
		})),
	);
}
