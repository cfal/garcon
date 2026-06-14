import {
	BashToolUseMessage,
	PermissionCancelledMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	ToolResultMessage,
} from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import type { ChatMessageRow } from './state.svelte';

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
			prevMessage: ChatMessage | null;
	  }
	| {
			kind: 'bash-group';
			id: string;
			messages: BashToolUseMessage[];
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

function bashGroupId(rows: ChatMessageRow[]): string {
	return `bash-group-${rows[0]?.id ?? 'empty'}`;
}

export function buildConversationFeedRenderModel(
	rows: ChatMessageRow[],
): ConversationFeedRenderModel {
	const items: ConversationFeedRenderItem[] = [];
	const toolResultIndex = new Map<string, ToolResultMessage>();
	const permissionTerminalById = new Map<string, PermissionTerminalState>();
	let previousRenderable: ChatMessage | null = null;
	let index = 0;

	while (index < rows.length) {
		const row = rows[index];
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
			const groupRows: ChatMessageRow[] = [];
			const group: BashToolUseMessage[] = [];
			const prevMessage = previousRenderable;
			const firstIndex = index;

			while (index < rows.length) {
				const candidateRow = rows[index];
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
			prevMessage: previousRenderable,
		});
		previousRenderable = message;
		index += 1;
	}

	return { items, toolResultIndex, permissionTerminalById };
}

export function buildConversationFeedRenderItems(
	rows: ChatMessageRow[],
): ConversationFeedRenderItem[] {
	return buildConversationFeedRenderModel(rows).items;
}
