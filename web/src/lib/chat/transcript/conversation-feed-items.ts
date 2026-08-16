import {
	AskUserQuestionToolUseMessage,
	PermissionCancelledMessage,
	PermissionExpiredMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	ToolResultMessage,
	isToolUseMessage,
	permissionOccurrenceKey,
} from '$shared/chat-types';
import type { ChatMessage, ToolUseChatMessage } from '$shared/chat-types';
import type { ChatDisplayRow } from './active-transcript-state.svelte.js';
import type { LocalNoticeRow } from '$lib/chat/transcript/local-notice.js';
import type { PendingPermissionRequest } from '$lib/types/chat';
import { TOOL_DISPLAY_REGISTRY } from '$lib/chat/tools/tool-display-registry.js';
import { resolveDisplayRule, shouldRenderToolResult } from '$lib/chat/tools/tool-display-policy.js';

export interface PermissionTerminalState {
	incarnation: string;
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
	ordinal?: number;
	awaitingDelivery?: boolean;
	pairedToolUse?: ToolUseChatMessage;
	permissionWrapperRowId?: string;
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
	permissionTerminalByOccurrence: Map<string, PermissionTerminalState>;
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
		message instanceof PermissionCancelledMessage ||
		message instanceof PermissionExpiredMessage
	) {
		return 'hidden';
	}
	if (message instanceof PermissionRequestMessage) return 'permission';
	if (message instanceof ToolResultMessage) {
		const tool = item.pairedToolUse;
		if (!tool) return 'hidden';
		if (tool instanceof AskUserQuestionToolUseMessage) {
			return item.permissionWrapperRowId ? 'hidden' : 'permission';
		}
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

interface PendingToolUse {
	rowId: string;
	message: ToolUseChatMessage;
	permissionWrapperRowId?: string;
}

interface ConversationToolPairs {
	toolResultByUseRowId: Map<string, ToolResultMessage>;
	toolResultRowIdByUseRowId: Map<string, string>;
	toolUseByResultRowId: Map<string, ToolUseChatMessage>;
	permissionWrapperRowIdByResultRowId: Map<string, string>;
}

function pairToolResults(rows: ChatDisplayRow[]): ConversationToolPairs {
	const pendingByToolId = new Map<string, PendingToolUse[]>();
	const pendingPermissionWrappersByToolId = new Map<string, string[]>();
	const toolResultByUseRowId = new Map<string, ToolResultMessage>();
	const toolResultRowIdByUseRowId = new Map<string, string>();
	const toolUseByResultRowId = new Map<string, ToolUseChatMessage>();
	const permissionWrapperRowIdByResultRowId = new Map<string, string>();
	for (const row of rows) {
		if (row.kind !== 'message') continue;
		const message = row.message;
		if (
			message instanceof PermissionRequestMessage &&
			message.requestedTool instanceof AskUserQuestionToolUseMessage
		) {
			const toolId = message.requestedTool.toolId;
			const pendingUse = pendingByToolId
				.get(toolId)
				?.find(
					(candidate) =>
						candidate.message instanceof AskUserQuestionToolUseMessage &&
						!candidate.permissionWrapperRowId,
				);
			if (pendingUse) {
				pendingUse.permissionWrapperRowId = row.id;
			} else {
				const wrappers = pendingPermissionWrappersByToolId.get(toolId) ?? [];
				wrappers.push(row.id);
				pendingPermissionWrappersByToolId.set(toolId, wrappers);
			}
			continue;
		}
		if (isToolUseMessage(message)) {
			const pending = pendingByToolId.get(message.toolId) ?? [];
			const pendingUse: PendingToolUse = { rowId: row.id, message };
			if (message instanceof AskUserQuestionToolUseMessage) {
				const wrappers = pendingPermissionWrappersByToolId.get(message.toolId);
				const permissionWrapperRowId = wrappers?.shift();
				if (permissionWrapperRowId) pendingUse.permissionWrapperRowId = permissionWrapperRowId;
				if (wrappers?.length === 0) pendingPermissionWrappersByToolId.delete(message.toolId);
			}
			pending.push(pendingUse);
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
		if (toolUse.permissionWrapperRowId) {
			permissionWrapperRowIdByResultRowId.set(row.id, toolUse.permissionWrapperRowId);
		}
	}
	return {
		toolResultByUseRowId,
		toolResultRowIdByUseRowId,
		toolUseByResultRowId,
		permissionWrapperRowIdByResultRowId,
	};
}

export function buildConversationFeedRenderModel(
	rows: ChatDisplayRow[],
): ConversationFeedRenderModel {
	const items: ConversationFeedRenderItem[] = [];
	const toolPairs = pairToolResults(rows);
	const permissionTerminalByOccurrence = new Map<string, PermissionTerminalState>();

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
			permissionTerminalByOccurrence.set(permissionOccurrenceKey(
				message.permissionRequestId,
				message.incarnation,
			), {
				incarnation: message.incarnation,
				state: 'resolved',
				allowed: message.allowed,
			});
		} else if (message instanceof PermissionCancelledMessage) {
			permissionTerminalByOccurrence.set(permissionOccurrenceKey(
				message.permissionRequestId,
				message.incarnation,
			), {
				incarnation: message.incarnation,
				state: 'cancelled',
				reason: message.reason,
			});
		} else if (message instanceof PermissionExpiredMessage) {
			permissionTerminalByOccurrence.set(permissionOccurrenceKey(
				message.permissionRequestId,
				message.incarnation,
			), {
				incarnation: message.incarnation,
				state: 'cancelled',
				reason: 'expired',
			});
		}

		items.push({
			kind: 'message',
			id: row.id,
			message,
			index,
			ordinal: row.ordinal,
			...(row.awaitingDelivery ? { awaitingDelivery: true } : {}),
			...(message instanceof ToolResultMessage
				? {
						pairedToolUse: toolPairs.toolUseByResultRowId.get(row.id),
						permissionWrapperRowId: toolPairs.permissionWrapperRowIdByResultRowId.get(row.id),
					}
				: {}),
		});
	}

	return {
		items,
		toolResultByUseRowId: toolPairs.toolResultByUseRowId,
		toolResultRowIdByUseRowId: toolPairs.toolResultRowIdByUseRowId,
		permissionTerminalByOccurrence,
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
	const renderedPermissionOccurrences = new Set<string>();
	const renderedExitPlanOccurrences = new Set<string>();
	const terminalPermissionOccurrences = new Set<string>();

	for (const row of rows) {
		if (row.kind !== 'message') continue;
		if (row.message instanceof PermissionRequestMessage) {
			renderedPermissionOccurrences.add(permissionOccurrenceKey(
				row.message.permissionRequestId,
				row.message.incarnation,
			));
		}
		if (row.message.type === 'exit-plan-mode-tool-use') {
			const requestId = `plan-exit-${row.message.toolId}`;
			renderedExitPlanOccurrences.add(permissionOccurrenceKey(requestId, requestId));
		}
		if (
			row.message instanceof PermissionResolvedMessage ||
			row.message instanceof PermissionCancelledMessage ||
			row.message instanceof PermissionExpiredMessage
		) {
			terminalPermissionOccurrences.add(permissionOccurrenceKey(
				row.message.permissionRequestId,
				row.message.incarnation,
			));
		}
	}

	const visiblePermissionOccurrences = new Set<string>();
	return pendingPermissionRequests.filter((request) => {
		const id = request.permissionRequestId;
		const occurrence = permissionOccurrenceKey(id, request.incarnation);
		if (renderedPermissionOccurrences.has(occurrence)) return false;
		if (renderedExitPlanOccurrences.has(occurrence)) return false;
		if (terminalPermissionOccurrences.has(occurrence)) return false;
		if (visiblePermissionOccurrences.has(occurrence)) return false;
		visiblePermissionOccurrences.add(occurrence);
		return true;
	});
}
