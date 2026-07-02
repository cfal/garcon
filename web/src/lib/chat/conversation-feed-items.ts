import {
	BashToolUseMessage,
	PermissionCancelledMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	ReadToolUseMessage,
	ToolResultMessage,
} from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import type { ChatDisplayRow, ChatTranscriptRow } from './state.svelte';
import type { LocalNoticeRow } from './local-notice';
import type { PendingPermissionRequest } from '$lib/types/chat';

export interface PermissionTerminalState {
	state: 'resolved' | 'cancelled';
	allowed?: boolean;
	reason?: string;
}

export type ConversationFeedRenderItem =
	| {
			kind: 'message';
			id: string;
			message: ChatMessage;
			index: number;
			seq?: number;
			prevMessage: ChatMessage | null;
	  }
	| {
			kind: 'bash-group';
			id: string;
			messages: BashToolUseMessage[];
			index: number;
			prevMessage: ChatMessage | null;
	  }
	| {
			kind: 'read-group';
			id: string;
			messages: ReadToolUseMessage[];
			index: number;
			prevMessage: ChatMessage | null;
	  }
	| {
			kind: 'local-notice';
			id: string;
			notice: LocalNoticeRow;
			index: number;
			prevMessage: ChatMessage | null;
	  };

export interface ConversationFeedRenderModel {
	items: ConversationFeedRenderItem[];
	toolResultIndex: Map<string, ToolResultMessage>;
	permissionTerminalById: Map<string, PermissionTerminalState>;
}

function shouldSkipStandaloneMessage(message: ChatMessage): boolean {
	return (
		message instanceof ToolResultMessage ||
		message instanceof PermissionResolvedMessage ||
		message instanceof PermissionCancelledMessage ||
		(message instanceof PermissionRequestMessage &&
			message.requestedTool.type === 'exit-plan-mode-tool-use')
	);
}

function bashGroupId(rows: ChatTranscriptRow[]): string {
	return `bash-group-${rows[0]?.id ?? 'empty'}`;
}

function readGroupId(rows: ChatTranscriptRow[]): string {
	return `read-group-${rows[0]?.id ?? 'empty'}`;
}

export function buildConversationFeedRenderModel(
	rows: ChatDisplayRow[],
): ConversationFeedRenderModel {
	const items: ConversationFeedRenderItem[] = [];
	const toolResultIndex = new Map<string, ToolResultMessage>();
	const permissionTerminalById = new Map<string, PermissionTerminalState>();
	let previousRenderable: ChatMessage | null = null;
	let index = 0;

	while (index < rows.length) {
		const row = rows[index];
		if (row.kind === 'local-notice') {
			items.push({
				kind: 'local-notice',
				id: row.id,
				notice: row,
				index,
				prevMessage: previousRenderable,
			});
			previousRenderable = null;
			index += 1;
			continue;
		}

		const message = row.message;

		if (message instanceof ToolResultMessage) {
			toolResultIndex.set(message.toolId, message);
		} else if (message instanceof PermissionResolvedMessage) {
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

		if (shouldSkipStandaloneMessage(message)) {
			index += 1;
			continue;
		}

		if (message instanceof BashToolUseMessage) {
			const groupRows: ChatTranscriptRow[] = [];
			const group: BashToolUseMessage[] = [];
			const prevMessage = previousRenderable;
			const firstIndex = index;

			while (index < rows.length) {
				const candidateRow = rows[index];
				if (candidateRow.kind === 'local-notice') break;
				const candidate = candidateRow.message;
				if (candidate instanceof ToolResultMessage) {
					toolResultIndex.set(candidate.toolId, candidate);
					index += 1;
					continue;
				}
				if (!(candidate instanceof BashToolUseMessage)) break;
				groupRows.push(candidateRow);
				group.push(candidate);
				previousRenderable = candidate;
				index += 1;
			}

			if (group.length > 1) {
				items.push({
					kind: 'bash-group',
					id: bashGroupId(groupRows),
					messages: group,
					index: firstIndex,
					prevMessage,
				});
			} else {
				items.push({
					kind: 'message',
					id: groupRows[0].id,
					message: group[0],
					index: firstIndex,
					seq: groupRows[0].seq,
					prevMessage,
				});
			}
			continue;
		}

		if (message instanceof ReadToolUseMessage) {
			const groupRows: ChatTranscriptRow[] = [];
			const group: ReadToolUseMessage[] = [];
			const prevMessage = previousRenderable;
			const firstIndex = index;

			while (index < rows.length) {
				const candidateRow = rows[index];
				if (candidateRow.kind === 'local-notice') break;
				const candidate = candidateRow.message;
				if (candidate instanceof ToolResultMessage) {
					toolResultIndex.set(candidate.toolId, candidate);
					index += 1;
					continue;
				}
				if (!(candidate instanceof ReadToolUseMessage)) break;
				groupRows.push(candidateRow);
				group.push(candidate);
				previousRenderable = candidate;
				index += 1;
			}

			if (group.length > 1) {
				items.push({
					kind: 'read-group',
					id: readGroupId(groupRows),
					messages: group,
					index: firstIndex,
					prevMessage,
				});
			} else {
				items.push({
					kind: 'message',
					id: groupRows[0].id,
					message: group[0],
					index: firstIndex,
					seq: groupRows[0].seq,
					prevMessage,
				});
			}
			continue;
		}

		items.push({
			kind: 'message',
			id: row.id,
			message,
			index,
			seq: row.seq,
			prevMessage: previousRenderable,
		});
		previousRenderable = message;
		index += 1;
	}

	return { items, toolResultIndex, permissionTerminalById };
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

	return pendingPermissionRequests.filter((request) => {
		if (renderedPermissionIds.has(request.permissionRequestId)) return false;
		if (terminalPermissionIds.has(request.permissionRequestId)) return false;
		return true;
	});
}
