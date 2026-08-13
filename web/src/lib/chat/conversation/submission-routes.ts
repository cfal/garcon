import type { ChatImage } from '$shared/chat-types';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import type { ApiProtocol } from '$shared/api-providers';
import type { AgentHandoffRequest } from '$shared/chat-command-contracts';
import type { ChatListEntry } from '$shared/chat-list';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';
import type { AcceptedInputSubmissionService } from './accepted-input-submission-service.js';
import type { ConversationQueueController } from './conversation-queue-controller.svelte.js';
import type { ConversationSubmissionOutcome } from './conversation-submission-outcome.js';
import { errorDetail, pendingUserInput } from './conversation-submission-helpers.js';
import { settleSubmissionFailure } from './submission-settlement.js';
import { CommandOutcomeUnknownError } from './idempotent-command.js';
import { steerFailureNotice } from './steer-failure-notice.js';
import {
	steerShortcutRejectionNotice,
	steerSubmissionRejection,
} from './steer-submission-policy.js';
import * as m from '$lib/paraglide/messages.js';

type RouteDeps = Pick<
	SessionControllerDeps,
	| 'sessions'
	| 'chatState'
	| 'composerState'
	| 'agentState'
	| 'lifecycle'
	| 'conversationUi'
	| 'startupCoordinator'
	| 'scrollToBottom'
>;

export interface SubmissionContext {
	chatId: string;
	chat: ChatSessionRecord;
	startup: ChatStartupConfig | undefined;
	text: string;
	content: string;
	images: ChatImage[];
	previousText: string;
	previousImages: File[];
	ownsComposer: boolean;
	composerRevisionAfterClear: number | null;
}

interface ExecutionModelSelection {
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
}

export async function submitQueueRoute(
	deps: RouteDeps,
	acceptedInputs: AcceptedInputSubmissionService,
	queue: ConversationQueueController,
	context: SubmissionContext,
): Promise<ConversationSubmissionOutcome> {
	const sequence = queue.beginSubmission(context.chatId);
	// Clears before awaiting the network so typing during the request survives.
	clearOwnedComposer(deps, context);
	const submission = acceptedInputs.enqueue({
		chatId: context.chatId,
		transcriptViewId: requireTranscriptView(deps, context.chatId),
		content: context.content,
	});
	try {
		const result = await submission.submit();
		deps.conversationUi.setExecutionControlFromLiveUpdate(context.chatId, result.control);
		return 'accepted';
	} catch (error) {
		return settleSubmissionFailure(deps, context, error, {
			unknownNotice: m.chat_notice_queue_outcome_unconfirmed(),
			rejectedNotice: (failure) => m.chat_notice_failed_queue_message({
				detail: errorDetail(failure),
				content: context.ownsComposer ? context.previousText : context.text,
			}),
			restoreRejected: () => queue.recordSubmissionFailure(context.chatId, {
				sequence,
				text: context.previousText,
				images: context.previousImages,
			}),
			refreshControl: () => queue.startControlRefresh(context.chatId),
		});
	} finally {
		queue.finishSubmission(context.chatId);
	}
}

export async function submitGoalControlRoute(
	deps: RouteDeps,
	acceptedInputs: AcceptedInputSubmissionService,
	queue: ConversationQueueController,
	context: SubmissionContext,
): Promise<ConversationSubmissionOutcome> {
	const sequence = queue.beginSubmission(context.chatId);
	clearOwnedComposer(deps, context);
	const submission = acceptedInputs.goalControl({
		chatId: context.chatId,
		transcriptViewId: requireTranscriptView(deps, context.chatId),
		content: context.content,
	});
	try {
		const result = await submission.submit();
		deps.conversationUi.setExecutionControlFromLiveUpdate(context.chatId, result.control);
		return 'accepted';
	} catch (error) {
		return settleSubmissionFailure(deps, context, error, {
			unknownNotice: m.chat_notice_queue_outcome_unconfirmed(),
			rejectedNotice: (failure) => m.chat_notice_failed_queue_message({
				detail: errorDetail(failure),
				content: context.ownsComposer ? context.previousText : context.text,
			}),
			restoreRejected: () => queue.recordSubmissionFailure(context.chatId, {
				sequence,
				text: context.previousText,
				images: context.previousImages,
			}),
			refreshControl: () => queue.startControlRefresh(context.chatId),
		});
	} finally {
		queue.finishSubmission(context.chatId);
	}
}

export async function submitSteerRoute(
	deps: RouteDeps,
	acceptedInputs: AcceptedInputSubmissionService,
	context: SubmissionContext,
): Promise<ConversationSubmissionOutcome> {
	const submission = acceptedInputs.steer({
		chatId: context.chatId,
		transcriptViewId: requireTranscriptView(deps, context.chatId),
		content: context.content,
	});
	deps.chatState.upsertPendingUserInput(
		pendingUserInput(
			context.chatId,
			context.content,
			[],
			submission.clientRequestId,
			submission.clientMessageId,
		),
	);
	if (deps.sessions.selectedChatId === context.chatId) deps.scrollToBottom();
	const clearedComposerRevision = clearOwnedComposer(deps, context);
	try {
		await submission.submit();
		deps.chatState.updatePendingUserInputDeliveryStatus(submission.clientRequestId, 'accepted');
		return 'accepted';
	} catch (error) {
		const outcomeUnknown = error instanceof CommandOutcomeUnknownError;
		deps.chatState.updatePendingUserInputDeliveryStatus(
			submission.clientRequestId,
			outcomeUnknown ? 'unconfirmed' : 'failed',
		);
		if (!outcomeUnknown) restoreSteerComposer(deps, context, clearedComposerRevision);
		if (deps.sessions.selectedChatId === context.chatId) {
			deps.chatState.appendLocalNotice(
				'error',
				outcomeUnknown
					? m.chat_notice_steer_outcome_unconfirmed()
					: steerFailureNotice(error),
			);
		}
		return outcomeUnknown ? 'unknown' : 'rejected';
	}
}

export function submitSteerPreferenceRoute(
	deps: RouteDeps,
	acceptedInputs: AcceptedInputSubmissionService,
	input: {
		chatId: string;
		chat: ChatSessionRecord;
		text: string;
		supportsSteering: boolean;
		handoffPending: boolean;
	},
): Promise<ConversationSubmissionOutcome> {
	const rejection = steerSubmissionRejection({
		prompt: input.text,
		supportsSteering: input.supportsSteering,
		attachmentCount: deps.composerState.images.length,
		handoffPending: input.handoffPending,
	});
	if (rejection) {
		deps.chatState.appendLocalNotice('error', steerShortcutRejectionNotice(rejection));
		return Promise.resolve('rejected');
	}

	return submitSteerRoute(deps, acceptedInputs, {
		chatId: input.chatId,
		chat: input.chat,
		startup: deps.sessions.startupByChatId[input.chatId],
		text: input.text,
		content: input.text,
		images: [],
		previousText: deps.composerState.inputText,
		previousImages: [...deps.composerState.images],
		ownsComposer: true,
		composerRevisionAfterClear: null,
	});
}

export async function submitDraftRoute(
	deps: RouteDeps,
	acceptedInputs: AcceptedInputSubmissionService,
	context: SubmissionContext,
): Promise<ConversationSubmissionOutcome> {
	const { chatId, chat, startup } = context;
	const submission = acceptedInputs.start(() => ({
		chatId,
		agentId: (startup?.agentId ?? chat.agentId) as typeof deps.agentState.agentId,
		projectPath: chat.projectPath!,
		model: startup?.model ?? chat.model ?? deps.agentState.model,
		apiProviderId: startup?.apiProviderId ?? chat.apiProviderId ?? deps.agentState.apiProviderId,
		modelEndpointId: startup?.modelEndpointId ?? chat.modelEndpointId ?? deps.agentState.modelEndpointId,
		modelProtocol: startup?.modelProtocol ?? chat.modelProtocol ?? deps.agentState.modelProtocol,
		permissionMode: startup?.permissionMode ?? deps.agentState.permissionMode,
		thinkingMode: startup?.thinkingMode ?? deps.agentState.thinkingMode,
		agentSettings: startup?.agentSettings ?? deps.agentState.agentSettings,
		command: context.text,
		images: context.images.length > 0 ? context.images : undefined,
		tags: startup?.tags,
	}));
	const composerRevisionAfterClear = beginOptimisticInput(
		deps,
		context,
		submission.clientRequestId,
		submission.clientMessageId,
	);
	deps.startupCoordinator.beginLocalStartup(chatId);
	try {
		const response = await submission.submit();
		deps.sessions.applyStartEntry(response.chat);
		deps.chatState.updatePendingUserInputDeliveryStatus(submission.clientRequestId, 'accepted');
		if (response.status === 'accepted') deps.lifecycle.beginTurn(chatId);
		else deps.startupCoordinator.completeStartup(chatId);
		return 'accepted';
	} catch (error) {
		console.error('[SessionController] Failed to start chat:', error);
		deps.startupCoordinator.completeStartup(chatId);
		return settleSubmissionFailure(deps, context, error, {
			clientRequestId: submission.clientRequestId,
			composerRevisionAfterClear,
			unknownNotice: m.chat_notice_delivery_outcome_unconfirmed(),
			rejectedNotice: (failure) => m.chat_notice_failed_start_chat({ detail: errorDetail(failure) }),
			onRejected: () => {
				deps.lifecycle.clearTurnStatus(chatId);
				deps.sessions.applyProcessingEvent(chatId, null);
			},
		});
	} finally {
		deps.composerState.isSubmitting = false;
	}
}

export async function submitRunRoute(
	deps: RouteDeps,
	acceptedInputs: AcceptedInputSubmissionService,
	queue: ConversationQueueController,
	context: SubmissionContext,
	selection: ExecutionModelSelection,
	handoff: AgentHandoffRequest | null,
	onHandoffAccepted: (chat: ChatListEntry) => void,
): Promise<ConversationSubmissionOutcome> {
	const submission = acceptedInputs.run({
		chatId: context.chatId,
		transcriptViewId: requireTranscriptView(deps, context.chatId),
		command: context.text,
		images: context.images.length > 0 ? context.images : undefined,
		...(handoff
			? { handoff }
			: {
				permissionMode: deps.agentState.permissionMode,
				thinkingMode: deps.agentState.thinkingMode,
				agentSettings: deps.agentState.agentSettings,
				...selection,
			}),
	});
	const composerRevisionAfterClear = beginOptimisticInput(
		deps,
		context,
		submission.clientRequestId,
		submission.clientMessageId,
	);
	try {
		const response = await submission.submit();
		if (handoff) {
			if (!response.chat) throw new Error('Accepted handoff response omitted its chat projection');
			deps.sessions.upsertServerChat(response.chat);
			onHandoffAccepted(response.chat);
		}
		deps.chatState.updatePendingUserInputDeliveryStatus(submission.clientRequestId, 'accepted');
		deps.lifecycle.beginTurn(context.chatId);
		return 'accepted';
	} catch (error) {
		return settleSubmissionFailure(deps, context, error, {
			clientRequestId: submission.clientRequestId,
			composerRevisionAfterClear,
			unknownNotice: m.chat_notice_delivery_outcome_unconfirmed(),
			rejectedNotice: (failure) => m.chat_notice_failed_send_message({ detail: errorDetail(failure) }),
			clearPendingOnAdmissionConflict: true,
			refreshControl: () => queue.settleControlRefresh(queue.startControlRefresh(context.chatId)),
		});
	} finally {
		deps.composerState.isSubmitting = false;
	}
}

function requireTranscriptView(deps: RouteDeps, chatId: string): string {
	const transcriptViewId = deps.chatState.getCursor().transcriptViewId;
	if (!transcriptViewId) throw new Error(`Transcript view is not loaded for ${chatId}`);
	return transcriptViewId;
}

function beginOptimisticInput(
	deps: RouteDeps,
	context: SubmissionContext,
	clientRequestId: string,
	clientMessageId: string,
): number | null {
	deps.chatState.upsertPendingUserInput(
		pendingUserInput(context.chatId, context.text, context.images, clientRequestId, clientMessageId),
	);
	if (deps.sessions.selectedChatId === context.chatId) deps.scrollToBottom();
	const composerRevisionAfterClear = clearOwnedComposer(deps, context);
	deps.composerState.isSubmitting = true;
	return composerRevisionAfterClear;
}

function clearOwnedComposer(deps: RouteDeps, context: SubmissionContext): number | null {
	if (!context.ownsComposer) return null;
	if (context.composerRevisionAfterClear !== null) return context.composerRevisionAfterClear;
	deps.composerState.clearAfterSubmit(context.chatId);
	return deps.composerState.contentRevision;
}

function restoreSteerComposer(
	deps: RouteDeps,
	context: SubmissionContext,
	clearedComposerRevision: number | null,
): void {
	if (
		!context.ownsComposer
		|| deps.sessions.selectedChatId !== context.chatId
		|| deps.composerState.contentRevision !== clearedComposerRevision
		|| deps.composerState.inputText !== ''
		|| deps.composerState.images.length > 0
	) return;
	deps.composerState.inputText = context.previousText;
	deps.composerState.images = context.previousImages;
	deps.composerState.saveDraft(context.chatId);
}
