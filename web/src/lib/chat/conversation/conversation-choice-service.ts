import { composerQuestion, composerQuestionKey } from '../composer/composer-question.js';
import { formatResponseChoiceAnswers, type ResponseChoiceAnswer } from '../composer/response-choices.js';
import type { ActiveTranscriptState } from '../transcript/active-transcript-state.svelte.js';
import { isCustomProviderSelectionAvailable } from '$lib/agents/provider-selection.js';
import type { AcceptedInputSubmissionService } from './accepted-input-submission-service.js';
import type { ConversationAdmissionController } from './conversation-admission-controller.svelte.js';
import type { SessionControllerDeps } from './conversation-session-controller-types.js';
import { ResponseChoiceController } from './response-choice-controller.svelte.js';
import { requiresQueuedSubmission } from './submission-classifier.js';

export type ChoiceTranscript = Pick<ActiveTranscriptState,
	'entries' | 'transcriptViewId' | 'hasLaterMessages' | 'excludedResendOrdinals'>;

interface LiteralChoiceSubmission {
	chatId: string;
	transcriptViewId: string;
	questionKey: string;
	answers: readonly ResponseChoiceAnswer[];
	transcript: ChoiceTranscript;
	isCurrent: () => boolean;
	clearResendExclusions: () => void;
}

export class ConversationChoiceService {
	readonly replies = new ResponseChoiceController();

	constructor(
		private readonly deps: SessionControllerDeps,
		private readonly admissions: ConversationAdmissionController,
		private readonly inputs: AcceptedInputSubmissionService,
	) {}

	async submit({ chatId, transcriptViewId: viewId, questionKey: key, answers, transcript, isCurrent, clearResendExclusions }: LiteralChoiceSubmission): Promise<boolean> {
		const { deps } = this;
		const chat = deps.sessions.byId[chatId];
		if (!chat?.agentOwnershipEpoch) return false;
		const captured = { ...chat, agentOwnershipEpoch: chat.agentOwnershipEpoch };
		const currentQuestion = () => {
			const chat = deps.sessions.byId[chatId];
			if (!isCurrent() || deps.sessions.selectedChatId !== chatId || transcript.transcriptViewId !== viewId
				|| chat?.agentOwnershipEpoch !== captured.agentOwnershipEpoch || chat.agentId !== captured.agentId
				|| chat.executorId !== captured.executorId || chat.status === 'draft') return null;
			const catalog = deps.modelCatalogForExecutor(chat.executorId ?? 'local');
			if (!deps.canSubmitToExecutor(chat.executorId ?? 'local')
				|| catalog.getAgent(chat.agentId)?.executionPolicy !== 'conversation'
				|| !isCustomProviderSelectionAvailable(catalog, chat)) return null;
			const question = composerQuestion(transcript.entries, deps.conversationUi.pendingPermissionsFor(chatId), {
				chatId, transcriptViewId: viewId, isProcessing: chat.isProcessing,
				hasLaterMessages: transcript.hasLaterMessages,
			});
			return question?.kind === 'plain' && composerQuestionKey(question, chatId, viewId) === key ? question : null;
		};
		if (!currentQuestion()) return false;
		const barrier = this.admissions.claim(chatId);
		if (!barrier) return false;
		try {
			return await this.replies.submit(key, chatId, async () => {
				const pendingSettings = this.admissions.settleSettings(chatId);
				if (pendingSettings && !(await pendingSettings)) return false;
				const pendingControl = this.admissions.settleQueueControl(chatId);
				if (pendingControl) await pendingControl;
				const question = currentQuestion();
				if (!question) return false;
				const answer = formatResponseChoiceAnswers(question.questions, answers);
				if (answer === null) return false;
				const target = {
					chatId, transcriptViewId: viewId, expectedAgentId: captured.agentId,
					expectedAgentOwnershipEpoch: captured.agentOwnershipEpoch,
					excludedResendOrdinals: [...transcript.excludedResendOrdinals],
				};
				if (requiresQueuedSubmission({ isProcessing: false, control: deps.conversationUi.getExecutionControl(chatId) })) {
					const result = await this.inputs.enqueue({ ...target, content: answer }).submit();
					if (deps.sessions.byId[chatId]?.agentOwnershipEpoch === captured.agentOwnershipEpoch)
						deps.conversationUi.setExecutionControlFromLiveUpdate(chatId, result.control);
				} else {
					await this.inputs.run({ ...target, command: answer }).submit();
					if (deps.sessions.byId[chatId]?.agentOwnershipEpoch === captured.agentOwnershipEpoch
						&& transcript.transcriptViewId === viewId) deps.lifecycleForChat(chatId).beginTurn(chatId);
					await deps.requestProcessingSnapshot('admission').catch(() => undefined);
				}
				if (deps.sessions.byId[chatId] && transcript.transcriptViewId === viewId) clearResendExclusions();
				return true;
			});
		} finally {
			this.admissions.release(chatId, barrier);
		}
	}
}
