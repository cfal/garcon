import type { AssistantMessage, AskUserQuestionToolUseMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import type { PendingPermissionRequest } from '$lib/types/chat';
import {
	isResponseChoiceReminder,
	hasResponseChoiceLimit,
	allowsMultipleResponseChoices,
	parseResponseChoices,
	type ResponseChoiceQuestion,
} from './response-choices.js';

export type ComposerQuestion =
	| {
			kind: 'permission';
			request: PendingPermissionRequest & { requestedTool: AskUserQuestionToolUseMessage };
	  }
	| { kind: 'async'; ordinal: number; message: AssistantMessage }
	| {
			kind: 'plain';
			questions: readonly ResponseChoiceQuestion[];
			sources: readonly { ordinal: number; contentWithoutOptions: string }[];
	  };

export function composerQuestion(
	entries: readonly TranscriptMessage[],
	permissions: readonly PendingPermissionRequest[],
	options: {
		isProcessing: boolean;
		hasLaterMessages: boolean;
		chatId?: string | null;
		transcriptViewId?: string;
	},
): ComposerQuestion | null {
	for (const request of permissions) {
		if (request.requestedTool.type === 'ask-user-question-tool-use') {
			return { kind: 'permission', request: { ...request, requestedTool: request.requestedTool } };
		}
	}
	if (options.hasLaterMessages) return null;
	let replySourceOrdinal: number | null = null;
	const repliedQuestions = new Map<string, string>();
	let latestAssistant = true;
	const plainQuestions: ResponseChoiceQuestion[] = [];
	const plainSources: { ordinal: number; contentWithoutOptions: string }[] = [];
	let reminderAllowsMultiple = false;
	let scannedContentLength = 0;
	// Only the loaded tail can offer a reply; older turns never become fresh questions.
	for (let index = entries.length - 1; index >= Math.max(0, entries.length - 100); index--) {
		const { ordinal, message } = entries[index];
		if (message.type === 'agent-switch') break;
		if (message.type === 'user-message') {
			if (plainSources.length) break;
			const reply = message.metadata?.questionReply;
			const source = reply?.source;
			if (
				!reply ||
				!source ||
				!options.chatId ||
				!options.transcriptViewId ||
				source.chatId !== options.chatId ||
				source.transcriptViewId !== options.transcriptViewId ||
				source.ordinal >= ordinal ||
				(replySourceOrdinal !== null && source.ordinal !== replySourceOrdinal)
			)
				return null;
			replySourceOrdinal = source.ordinal;
			repliedQuestions.set(reply.questionId, reply.question);
			continue;
		}
		if (message.type !== 'assistant-message') continue;
		if (replySourceOrdinal !== null && ordinal > replySourceOrdinal) {
			if (message.questions?.questions.length || parseResponseChoices(message.content)) return null;
			latestAssistant = false;
			continue;
		}
		// An answer to one prompt keeps its sibling prompts available in the same source set.
		if (
			replySourceOrdinal !== null &&
			(ordinal !== replySourceOrdinal ||
				[...repliedQuestions].some(
					([id, prompt]) =>
						!message.questions?.questions.some(
							(question) => question.id === id && question.prompt === prompt,
						),
				))
		)
			return null;
		if (message.questions?.questions.length) {
			if (plainSources.length) break;
			return { kind: 'async', ordinal, message };
		}
		if (latestAssistant) {
			if (isResponseChoiceReminder(message.content)) {
				if (hasResponseChoiceLimit(message.content)) return null;
				reminderAllowsMultiple ||= allowsMultipleResponseChoices(message.content);
				continue;
			}
			scannedContentLength += message.content.length;
			if (scannedContentLength > 24_000) break;
			const parsed = parseResponseChoices(message.content);
			if (parsed) {
				if (options.isProcessing) return null;
				if (plainSources.length >= 10 || plainQuestions.length + parsed.questions.length > 100) break;
				plainSources.unshift({ ordinal, contentWithoutOptions: parsed.contentWithoutOptions });
				plainQuestions.unshift(...parsed.questions.map(question => ({
					...question,
					id: `${ordinal}:${question.id}`,
					allowMultiple: question.allowMultiple || reminderAllowsMultiple,
				})));
				reminderAllowsMultiple = false;
				continue;
			}
			if (plainSources.length) break;
		}
		latestAssistant = false;
	}
	return plainSources.length ? { kind: 'plain', questions: plainQuestions, sources: plainSources } : null;
}

export function composerQuestionKey(
	question: ComposerQuestion,
	chatId: string,
	viewId: string,
): string {
	return JSON.stringify([
		chatId,
		viewId,
		question.kind,
		question.kind === 'permission' ? question.request.permissionOccurrenceId
			: question.kind === 'plain' ? question.sources.map(source => source.ordinal) : question.ordinal,
	]);
}
