import {
	AskUserQuestionToolUseMessage,
	BashToolUseMessage,
	PermissionCancelledMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	ReadToolUseMessage,
	ToolResultMessage,
} from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import type { ChatDisplayRow, ChatTranscriptRow } from './active-transcript-state.svelte.js';
import type { LocalNoticeRow } from '$lib/chat/transcript/local-notice.js';
import type { PendingPermissionRequest } from '$lib/types/chat';
import { isRecord } from '$shared/json';

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

export function filterHiddenToolRenderItems(
	items: ConversationFeedRenderItem[],
	hiddenToolTypes: readonly string[],
): ConversationFeedRenderItem[] {
	if (hiddenToolTypes.length === 0) return items;
	const hidden = new Set(hiddenToolTypes);
	return items.filter((item) => {
		if (item.kind === 'bash-group') return !hidden.has('bash-tool-use');
		if (item.kind === 'read-group') return !hidden.has('read-tool-use');
		return item.kind !== 'message' || !hidden.has(item.message.type);
	});
}

function rawToolResultText(content: Record<string, unknown>): string {
	const raw = content.raw ?? content.content;
	return typeof raw === 'string' ? raw : '';
}

function askUserQuestionAnswerMap(result: ToolResultMessage): Record<string, unknown> | null {
	const toolUseResult = isRecord(result.content.toolUseResult)
		? result.content.toolUseResult
		: null;
	const answers = toolUseResult && isRecord(toolUseResult.answers) ? toolUseResult.answers : null;
	return answers;
}

function rawAnswerValues(
	answer: unknown,
	optionLabels: Set<string>,
	optionIds: Set<string>,
): string[] {
	if (Array.isArray(answer)) {
		return answer.flatMap((entry) => rawAnswerValues(entry, optionLabels, optionIds));
	}
	if (typeof answer !== 'string') return [];
	const trimmed = answer.trim();
	if (!trimmed) return [];
	if (optionLabels.has(trimmed) || optionIds.has(trimmed)) return [trimmed];
	return trimmed
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function selectedOptionIdsForAnswer(
	question: AskUserQuestionToolUseMessage['questions'][number],
	answer: unknown,
): string[] {
	const optionByLabel = new Map(question.options.map((option) => [option.label, option.id]));
	const optionById = new Map(question.options.map((option) => [option.id, option.id]));
	const values = rawAnswerValues(answer, new Set(optionByLabel.keys()), new Set(optionById.keys()));
	const selected = values
		.map((value) => optionById.get(value) ?? optionByLabel.get(value))
		.filter((value): value is string => Boolean(value));
	return Array.from(new Set(selected));
}

function selectedQuestionOptionsFromAnswers(
	tool: AskUserQuestionToolUseMessage,
	answers: Record<string, unknown>,
): Record<string, string[]> {
	const selectedQuestionOptions: Record<string, string[]> = {};
	for (const question of tool.questions) {
		const answer = answers[question.id] ?? answers[question.prompt];
		if (answer === undefined) continue;
		const selected = selectedOptionIdsForAnswer(question, answer);
		if (selected.length > 0) selectedQuestionOptions[question.id] = selected;
	}
	return selectedQuestionOptions;
}

function parseAnsweredText(
	tool: AskUserQuestionToolUseMessage,
	text: string,
): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	for (const question of tool.questions) {
		const questionIndex = text.indexOf(`"${question.prompt}"="`);
		if (questionIndex === -1) continue;
		const valueStart = questionIndex + question.prompt.length + 4;
		const valueEnd = text.indexOf('"', valueStart);
		if (valueEnd === -1) continue;
		answers[question.id] = text.slice(valueStart, valueEnd);
	}
	return answers;
}

export function askUserQuestionPermissionId(toolId: string): string {
	return `ask-user-question-${toolId || 'unknown'}`;
}

export function askUserQuestionTerminalFromResult(
	tool: AskUserQuestionToolUseMessage,
	result: ToolResultMessage | undefined,
): PermissionTerminalState | undefined {
	if (!result) return undefined;
	const answers = askUserQuestionAnswerMap(result);
	const rawText = rawToolResultText(result.content);

	if (answers) {
		if (Object.keys(answers).length === 0) {
			return { state: 'resolved', allowed: false, reason: rawText || 'User skipped question' };
		}
		return {
			state: 'resolved',
			allowed: true,
			selectedQuestionOptions: selectedQuestionOptionsFromAnswers(tool, answers),
		};
	}

	if (/did not answer|declined to answer|skipped question|skipped the question/i.test(rawText)) {
		return { state: 'resolved', allowed: false, reason: rawText || 'User skipped question' };
	}

	const parsedAnswers = parseAnsweredText(tool, rawText);
	if (Object.keys(parsedAnswers).length > 0) {
		return {
			state: 'resolved',
			allowed: true,
			selectedQuestionOptions: selectedQuestionOptionsFromAnswers(tool, parsedAnswers),
		};
	}

	return {
		state: 'resolved',
		allowed: !result.isError,
		reason: result.isError ? rawText : undefined,
	};
}

function explicitPermissionToolIds(rows: ChatDisplayRow[]): Set<string> {
	const toolIds = new Set<string>();
	for (const row of rows) {
		if (row.kind !== 'message') continue;
		const message = row.message;
		if (!(message instanceof PermissionRequestMessage)) continue;
		const toolId = message.requestedTool.toolId;
		if (toolId) toolIds.add(toolId);
	}
	return toolIds;
}

function shouldSkipStandaloneMessage(
	message: ChatMessage,
	permissionToolIds: Set<string>,
): boolean {
	return (
		message instanceof ToolResultMessage ||
		message instanceof PermissionResolvedMessage ||
		message instanceof PermissionCancelledMessage ||
		(message instanceof PermissionRequestMessage &&
			message.requestedTool.type === 'exit-plan-mode-tool-use') ||
		(message instanceof AskUserQuestionToolUseMessage &&
			Boolean(message.toolId) &&
			permissionToolIds.has(message.toolId))
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
	const permissionToolIds = explicitPermissionToolIds(rows);
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

		if (shouldSkipStandaloneMessage(message, permissionToolIds)) {
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
