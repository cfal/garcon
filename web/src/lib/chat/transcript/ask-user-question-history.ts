import {
	AskUserQuestionToolUseMessage,
	PermissionRequestMessage,
	ToolResultMessage,
} from '$shared/chat-types';
import { isRecord } from '$shared/json';
import type { PermissionTerminalState } from './conversation-feed-items.js';

export interface HistoricalAskUserQuestion {
	request: PermissionRequestMessage;
	terminal: PermissionTerminalState;
}

function rawToolResultText(content: Record<string, unknown>): string {
	const raw = content.raw ?? content.content;
	return typeof raw === 'string' ? raw : '';
}

function answerMap(result: ToolResultMessage): Record<string, unknown> | null {
	const toolUseResult = isRecord(result.content.toolUseResult)
		? result.content.toolUseResult
		: null;
	return toolUseResult && isRecord(toolUseResult.answers) ? toolUseResult.answers : null;
}

function answerValues(
	answer: unknown,
	optionLabels: Set<string>,
	optionIds: Set<string>,
): string[] {
	if (Array.isArray(answer)) {
		return answer.flatMap((entry) => answerValues(entry, optionLabels, optionIds));
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

function selectedOptionIds(
	question: AskUserQuestionToolUseMessage['questions'][number],
	answer: unknown,
): string[] {
	const optionIdByLabel = new Map(question.options.map((option) => [option.label, option.id]));
	const optionIds = new Set(question.options.map((option) => option.id));
	const values = answerValues(answer, new Set(optionIdByLabel.keys()), optionIds);
	return Array.from(
		new Set(
			values.flatMap((value) => {
				if (optionIds.has(value)) return [value];
				const id = optionIdByLabel.get(value);
				return id ? [id] : [];
			}),
		),
	);
}

function selectedQuestionOptions(
	tool: AskUserQuestionToolUseMessage,
	answers: Record<string, unknown>,
): Record<string, string[]> {
	const selected: Record<string, string[]> = {};
	for (const question of tool.questions) {
		const answer = answers[question.id] ?? answers[question.prompt];
		if (answer === undefined) continue;
		const optionIds = selectedOptionIds(question, answer);
		if (optionIds.length > 0) selected[question.id] = optionIds;
	}
	return selected;
}

function answersFromLegacyText(
	tool: AskUserQuestionToolUseMessage,
	text: string,
): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	for (const question of tool.questions) {
		const prefix = `"${question.prompt}"="`;
		const questionIndex = text.indexOf(prefix);
		if (questionIndex === -1) continue;
		const valueStart = questionIndex + prefix.length;
		const valueEnd = text.indexOf('"', valueStart);
		if (valueEnd !== -1) answers[question.id] = text.slice(valueStart, valueEnd);
	}
	return answers;
}

function terminalFromResult(
  tool: AskUserQuestionToolUseMessage,
  result: ToolResultMessage,
): Omit<PermissionTerminalState, 'permissionOccurrenceId'> {
	const answers = answerMap(result);
	const rawText = rawToolResultText(result.content);
	if (answers) {
		if (Object.keys(answers).length === 0) {
			return { state: 'resolved', allowed: false, reason: rawText || 'User skipped question' };
		}
		return {
			state: 'resolved',
			allowed: true,
			selectedQuestionOptions: selectedQuestionOptions(tool, answers),
		};
	}

	if (/did not answer|declined to answer|skipped question|skipped the question/i.test(rawText)) {
		return { state: 'resolved', allowed: false, reason: rawText || 'User skipped question' };
	}

	const legacyAnswers = answersFromLegacyText(tool, rawText);
	if (Object.keys(legacyAnswers).length > 0) {
		return {
			state: 'resolved',
			allowed: true,
			selectedQuestionOptions: selectedQuestionOptions(tool, legacyAnswers),
		};
	}

	return {
		state: 'resolved',
		allowed: !result.isError,
		reason: result.isError ? rawText : undefined,
	};
}

export function historicalAskUserQuestion(
	tool: AskUserQuestionToolUseMessage,
	result: ToolResultMessage,
): HistoricalAskUserQuestion {
	const permissionOccurrenceId = `ask-user-question-${tool.toolId || 'unknown'}`;
	return {
		request: new PermissionRequestMessage(
			tool.timestamp,
			permissionOccurrenceId,
			tool,
		),
		terminal: { ...terminalFromResult(tool, result), permissionOccurrenceId },
	};
}
