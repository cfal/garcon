import type { ChatImage } from '$shared/chat-types';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import type { ApiProtocol } from '$shared/api-providers';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';
import type { AcceptedInputSubmissionService } from './accepted-input-submission-service.js';
import type { ConversationQueueController } from './conversation-queue-controller.svelte.js';
import type { ConversationSubmissionOutcome } from './conversation-submission-outcome.js';
import { errorDetail, pendingUserInput } from './conversation-submission-helpers.js';
import { settleSubmissionFailure } from './submission-settlement.js';
import { ApiError } from '$lib/api/client.js';
import { CommandOutcomeUnknownError } from './idempotent-command.js';
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
	restoreComposerOnFailure: boolean;
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
	if (context.restoreComposerOnFailure) deps.composerState.clearAfterSubmit(context.chatId);
	const submission = acceptedInputs.enqueue({ chatId: context.chatId, content: context.content });
	try {
		const result = await submission.submit();
		deps.conversationUi.setExecutionControl(context.chatId, result.control);
		return 'accepted';
	} catch (error) {
		return settleSubmissionFailure(deps, context, error, {
			unknownNotice: m.chat_notice_queue_outcome_unconfirmed(),
			rejectedNotice: (failure) => m.chat_notice_failed_queue_message({
				detail: errorDetail(failure),
				content: context.restoreComposerOnFailure ? context.previousText : context.text,
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
	if (context.restoreComposerOnFailure) deps.composerState.clearAfterSubmit(context.chatId);
	const submission = acceptedInputs.goalControl({
		chatId: context.chatId,
		content: context.content,
	});
	try {
		const result = await submission.submit();
		deps.conversationUi.setExecutionControl(context.chatId, result.control);
		return 'accepted';
	} catch (error) {
		return settleSubmissionFailure(deps, context, error, {
			unknownNotice: m.chat_notice_queue_outcome_unconfirmed(),
			rejectedNotice: (failure) => m.chat_notice_failed_queue_message({
				detail: errorDetail(failure),
				content: context.restoreComposerOnFailure ? context.previousText : context.text,
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
	deps.chatState.isUserScrolledUp = false;
	let clearedComposerRevision: number | null = null;
	if (context.restoreComposerOnFailure) {
		deps.composerState.clearAfterSubmit(context.chatId);
		clearedComposerRevision = deps.composerState.contentRevision;
	}
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
	beginOptimisticInput(deps, context, submission.clientRequestId, submission.clientMessageId);
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
): Promise<ConversationSubmissionOutcome> {
	const submission = acceptedInputs.run({
		chatId: context.chatId,
		command: context.text,
		images: context.images.length > 0 ? context.images : undefined,
		permissionMode: deps.agentState.permissionMode,
		thinkingMode: deps.agentState.thinkingMode,
		agentSettings: deps.agentState.agentSettings,
		...selection,
	});
	beginOptimisticInput(deps, context, submission.clientRequestId, submission.clientMessageId);
	try {
		await submission.submit();
		deps.chatState.updatePendingUserInputDeliveryStatus(submission.clientRequestId, 'accepted');
		deps.lifecycle.beginTurn(context.chatId);
		return 'accepted';
	} catch (error) {
		return settleSubmissionFailure(deps, context, error, {
			clientRequestId: submission.clientRequestId,
			unknownNotice: m.chat_notice_delivery_outcome_unconfirmed(),
			rejectedNotice: (failure) => m.chat_notice_failed_send_message({ detail: errorDetail(failure) }),
			clearPendingOnAdmissionConflict: true,
			refreshControl: () => queue.settleControlRefresh(queue.startControlRefresh(context.chatId)),
		});
	} finally {
		deps.composerState.isSubmitting = false;
	}
}

function beginOptimisticInput(
	deps: RouteDeps,
	context: SubmissionContext,
	clientRequestId: string,
	clientMessageId: string,
): void {
	deps.chatState.upsertPendingUserInput(
		pendingUserInput(context.chatId, context.text, context.images, clientRequestId, clientMessageId),
	);
	deps.chatState.isUserScrolledUp = false;
	if (context.restoreComposerOnFailure) deps.composerState.clearAfterSubmit(context.chatId);
	deps.composerState.isSubmitting = true;
}

function restoreSteerComposer(
	deps: RouteDeps,
	context: SubmissionContext,
	clearedComposerRevision: number | null,
): void {
	if (
		!context.restoreComposerOnFailure
		|| deps.sessions.selectedChatId !== context.chatId
		|| deps.composerState.contentRevision !== clearedComposerRevision
		|| deps.composerState.inputText !== ''
		|| deps.composerState.images.length > 0
	) return;
	deps.composerState.inputText = context.previousText;
	deps.composerState.images = context.previousImages;
	deps.composerState.saveDraft(context.chatId);
}

function steerFailureNotice(error: unknown): string {
	if (error instanceof ApiError) {
		switch (error.errorCode) {
			case 'OPERATION_UNSUPPORTED':
				return m.chat_notice_steer_unsupported();
			case 'STEER_TURN_UNAVAILABLE':
				return m.chat_notice_steer_turn_unavailable();
			case 'STEER_TURN_CHANGED':
				return m.chat_notice_steer_turn_changed();
			case 'STEER_TURN_NOT_STEERABLE':
				return m.chat_notice_steer_turn_not_steerable();
			case 'STEER_PROVIDER_REJECTED':
				return m.chat_notice_steer_provider_rejected();
			case 'STEER_NOT_DELIVERED':
				return m.chat_notice_steer_not_delivered();
		}
	}
	return m.chat_notice_failed_steer({ detail: errorDetail(error) });
}
