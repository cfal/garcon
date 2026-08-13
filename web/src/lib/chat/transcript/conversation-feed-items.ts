import {
	PermissionCancelledMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	ToolResultMessage,
	isToolUseMessage,
} from '$shared/chat-types';
import type { ChatMessage, ToolUseChatMessage } from '$shared/chat-types';
import type { ChatDisplayRow } from './active-transcript-state.svelte.js';
import type { LocalNoticeRow } from '$lib/chat/transcript/local-notice.js';
import type { PendingPermissionRequest } from '$lib/types/chat';

export interface PermissionTerminalState {
	state: 'resolved' | 'cancelled';
	allowed?: boolean;
	reason?: string;
	selectedQuestionOptions?: Record<string, string[]>;
}

export type ConversationFeedRenderItem =
	| {
			kind: 'message';
			id: string;
			message: ChatMessage;
			index: number;
			seq?: number;
	  }
	| {
			kind: 'local-notice';
			id: string;
			notice: LocalNoticeRow;
			index: number;
	  };

export interface ConversationFeedRenderModel {
	items: ConversationFeedRenderItem[];
	toolResultByUseRowId: Map<string, ToolResultMessage>;
	toolResultRowIdByUseRowId: Map<string, string>;
	toolUseByResultRowId: Map<string, ToolUseChatMessage>;
	permissionTerminalById: Map<string, PermissionTerminalState>;
}

export function filterHiddenToolRenderItems<T extends ConversationFeedRenderItem>(
	items: T[],
	hiddenToolTypes: readonly string[],
): T[] {
	if (hiddenToolTypes.length === 0) return items;
	const hidden = new Set(hiddenToolTypes);
	return items.filter((item) => item.kind !== 'message' || !hidden.has(item.message.type));
}

function pairToolResults(
	rows: ChatDisplayRow[],
): Pick<
	ConversationFeedRenderModel,
	'toolResultByUseRowId' | 'toolResultRowIdByUseRowId' | 'toolUseByResultRowId'
> {
	const pendingByToolId = new Map<
		string,
		Array<{ rowId: string; message: ToolUseChatMessage }>
	>();
	const toolResultByUseRowId = new Map<string, ToolResultMessage>();
	const toolResultRowIdByUseRowId = new Map<string, string>();
	const toolUseByResultRowId = new Map<string, ToolUseChatMessage>();
	for (const row of rows) {
		if (row.kind !== 'message') continue;
		const message = row.message;
		if (isToolUseMessage(message)) {
			const pending = pendingByToolId.get(message.toolId) ?? [];
			pending.push({ rowId: row.id, message });
			pendingByToolId.set(message.toolId, pending);
			continue;
		}
		if (!(message instanceof ToolResultMessage)) continue;
		const pending = pendingByToolId.get(message.toolId);
		if (!pending) continue;
		const toolUse = pending.shift();
		if (!toolUse) continue;
		if (pending.length === 0) pendingByToolId.delete(message.toolId);
		toolResultByUseRowId.set(toolUse.rowId, message);
		toolResultRowIdByUseRowId.set(toolUse.rowId, row.id);
		toolUseByResultRowId.set(row.id, toolUse.message);
	}
	return { toolResultByUseRowId, toolResultRowIdByUseRowId, toolUseByResultRowId };
}

export function buildConversationFeedRenderModel(
	rows: ChatDisplayRow[],
): ConversationFeedRenderModel {
	const items: ConversationFeedRenderItem[] = [];
	const toolPairs = pairToolResults(rows);
	const permissionTerminalById = new Map<string, PermissionTerminalState>();

	for (const [index, row] of rows.entries()) {
		if (row.kind === 'local-notice') {
			items.push({
				kind: 'local-notice',
				id: row.id,
				notice: row,
				index,
			});
			continue;
		}

		const message = row.message;

		if (message instanceof PermissionResolvedMessage) {
			permissionTerminalById.set(message.permissionRequestId, {
				state: 'resolved',
				allowed: message.allowed,
			});
		} else if (message instanceof PermissionCancelledMessage) {
			permissionTerminalById.set(message.permissionRequestId, {
				state: 'cancelled',
				reason: message.reason,
			});
		}

		items.push({
			kind: 'message',
			id: row.id,
			message,
			index,
			seq: row.seq,
		});
	}

	return { items, ...toolPairs, permissionTerminalById };
}

export function buildConversationFeedRenderItems(
	rows: ChatDisplayRow[],
): ConversationFeedRenderItem[] {
	return buildConversationFeedRenderModel(rows).items;
}

export function visiblePendingPermissionRequests(
	rows: ChatDisplayRow[],
	pendingPermissionRequests: PendingPermissionRequest[],
): PendingPermissionRequest[] {
	const renderedPermissionIds = new Set<string>();
	const terminalPermissionIds = new Set<string>();

	for (const row of rows) {
		if (row.kind !== 'message') continue;
		if (row.message instanceof PermissionRequestMessage) {
			renderedPermissionIds.add(row.message.permissionRequestId);
		}
		if (
			row.message instanceof PermissionResolvedMessage ||
			row.message instanceof PermissionCancelledMessage
		) {
			terminalPermissionIds.add(row.message.permissionRequestId);
		}
	}

	const visiblePermissionIds = new Set<string>();
	return pendingPermissionRequests.filter((request) => {
		const id = request.permissionRequestId;
		if (renderedPermissionIds.has(id)) return false;
		if (terminalPermissionIds.has(id)) return false;
		if (visiblePermissionIds.has(id)) return false;
		visiblePermissionIds.add(id);
		return true;
	});
}
