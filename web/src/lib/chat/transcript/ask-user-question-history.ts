import {
	AskUserQuestionToolUseMessage,
	PermissionRequestMessage,
	ToolResultMessage,
	type AskUserQuestionPrompt,
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

function legacyAnswerValues(
	answer: unknown,
	optionLabels: Set<string>,
	optionIds: Set<string>,
): string[] {
	if (Array.isArray(answer)) {
		return answer.flatMap((entry) => legacyAnswerValues(entry, optionLabels, optionIds));
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

function completeAnswerValues(answer: unknown): string[] {
	if (typeof answer === 'string') return [answer];
	if (Array.isArray(answer)) return answer.filter((value): value is string => typeof value === 'string');
	return [];
}

function selectedOptionIds(
	question: AskUserQuestionPrompt,
	answer: unknown,
): string[] {
	const optionIdByLabel = new Map(question.options.map((option) => [option.label, option.id]));
	const optionIds = new Set(question.options.map((option) => option.id));
	const values = question.allowFreeText
		? completeAnswerValues(answer)
		: legacyAnswerValues(answer, new Set(optionIdByLabel.keys()), optionIds);
	if (question.allowFreeText) {
		// Native answers contain labels or text, never generated option IDs.
		if (values.some((value) => !optionIdByLabel.has(value))) return [];
		return Array.from(new Set(values.map((value) => optionIdByLabel.get(value)!)));
	}
	return Array.from(
		new Set(
			values.flatMap((value) => {
				const id = optionIdByLabel.get(value);
				if (optionIds.has(value)) return [value];
				return id ? [id] : [];
			}),
		),
	);
}

function answerForQuestion(
	question: AskUserQuestionPrompt,
	answers: Record<string, unknown>,
): unknown {
	const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
	if (answer != null) return answer;
	return Object.hasOwn(answers, question.prompt) ? answers[question.prompt] : undefined;
}

function selectedQuestionOptions(
	tool: AskUserQuestionToolUseMessage,
	answers: Record<string, unknown>,
): Record<string, string[]> {
	const selected = new Map<string, string[]>();
	for (const question of tool.questions) {
		const answer = answerForQuestion(question, answers);
		if (answer === undefined) continue;
		const optionIds = selectedOptionIds(question, answer);
		if (optionIds.length > 0) selected.set(question.id, optionIds);
	}
	return Object.fromEntries(selected);
}

function answersFromLegacyText(
	tool: AskUserQuestionToolUseMessage,
	text: string,
): Record<string, unknown> {
	const answers = new Map<string, string>();
	for (const question of tool.questions) {
		const prefix = `"${question.prompt}"="`;
		const questionIndex = text.indexOf(prefix);
		if (questionIndex === -1) continue;
		const valueStart = questionIndex + prefix.length;
		const valueEnd = text.indexOf('"', valueStart);
		if (valueEnd !== -1) answers.set(question.id, text.slice(valueStart, valueEnd));
	}
	return Object.fromEntries(answers);
}

function questionTextAnswers(
	tool: AskUserQuestionToolUseMessage,
	answers: Record<string, unknown>,
	explicitTexts: unknown,
): Record<string, string> {
	const texts = new Map<string, string>();
	for (const question of tool.questions) {
		if (!question.allowFreeText && !question.allowNotes) continue;
		const explicitText = isRecord(explicitTexts) && Object.hasOwn(explicitTexts, question.id)
			? explicitTexts[question.id] : undefined;
		if (typeof explicitText === 'string') {
			texts.set(question.id, explicitText);
			continue;
		}
		const answer = answerForQuestion(question, answers);
		if (selectedOptionIds(question, answer).length > 0) continue;
		const text = completeAnswerValues(answer).join('\n');
		if (text) texts.set(question.id, text);
	}
	return Object.fromEntries(texts);
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
			questionTextAnswers: questionTextAnswers(tool, answers,
				isRecord(result.content.toolUseResult) ? result.content.toolUseResult.textAnswers : undefined),
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
