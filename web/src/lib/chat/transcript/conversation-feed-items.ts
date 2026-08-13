import {
	AskUserQuestionToolUseMessage,
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
import { TOOL_DISPLAY_REGISTRY } from '$lib/chat/tools/tool-display-registry.js';
import { resolveDisplayRule, shouldRenderToolResult } from '$lib/chat/tools/tool-display-policy.js';

export interface PermissionTerminalState {
	state: 'resolved' | 'cancelled';
	allowed?: boolean;
	reason?: string;
	selectedQuestionOptions?: Record<string, string[]>;
}

export interface ConversationFeedMessageRenderItem {
	kind: 'message';
	id: string;
	message: ChatMessage;
	index: number;
	seq?: number;
	pairedToolUse?: ToolUseChatMessage;
}

export type ConversationFeedRenderItem =
	| ConversationFeedMessageRenderItem
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
	permissionTerminalById: Map<string, PermissionTerminalState>;
}

export type ConversationFeedItemLayout = 'hidden' | 'standard' | 'permission';

export function filterHiddenToolRenderItems<T extends ConversationFeedRenderItem>(
	items: T[],
	hiddenToolTypes: readonly string[],
): T[] {
	if (hiddenToolTypes.length === 0) return items;
	const hidden = new Set(hiddenToolTypes);
	return items.filter((item) => {
		if (item.kind !== 'message') return true;
		const toolType =
			item.message instanceof ToolResultMessage ? item.pairedToolUse?.type : item.message.type;
		return !toolType || !hidden.has(toolType);
	});
}

export function conversationFeedItemLayout(
	item: ConversationFeedRenderItem,
): ConversationFeedItemLayout {
	if (item.kind === 'local-notice') return 'standard';
	const message = item.message;
	if (
		message instanceof PermissionResolvedMessage ||
		message instanceof PermissionCancelledMessage
	) {
		return 'hidden';
	}
	if (message instanceof PermissionRequestMessage) return 'permission';
	if (message instanceof ToolResultMessage) {
		const tool = item.pairedToolUse;
		if (!tool) return 'hidden';
		if (tool instanceof AskUserQuestionToolUseMessage) return 'permission';
		const rule = resolveDisplayRule(TOOL_DISPLAY_REGISTRY, tool.type);
		return shouldRenderToolResult(rule, {
			content: message.content,
			isError: message.isError,
		})
			? 'standard'
			: 'hidden';
	}
	if (!isToolUseMessage(message)) return 'standard';
	if (message.type === 'exit-plan-mode-tool-use') return 'permission';
	if (message.type === 'enter-plan-mode-tool-use') return 'standard';
	const rule = resolveDisplayRule(TOOL_DISPLAY_REGISTRY, message.type);
	return rule.input.mode === 'hidden' ? 'hidden' : 'standard';
}

interface ConversationToolPairs {
	toolResultByUseRowId: Map<string, ToolResultMessage>;
	toolResultRowIdByUseRowId: Map<string, string>;
	toolUseByResultRowId: Map<string, ToolUseChatMessage>;
}

function pairToolResults(rows: ChatDisplayRow[]): ConversationToolPairs {
	const pendingByToolId = new Map<string, Array<{ rowId: string; message: ToolUseChatMessage }>>();
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
			...(message instanceof ToolResultMessage
				? { pairedToolUse: toolPairs.toolUseByResultRowId.get(row.id) }
				: {}),
		});
	}

	return {
		items,
		toolResultByUseRowId: toolPairs.toolResultByUseRowId,
		toolResultRowIdByUseRowId: toolPairs.toolResultRowIdByUseRowId,
		permissionTerminalById,
	};
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
		if (row.message.type === 'exit-plan-mode-tool-use') {
			renderedPermissionIds.add(`plan-exit-${row.message.toolId}`);
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
