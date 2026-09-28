import * as m from '$lib/paraglide/messages.js';
import type { PermissionMode } from '$lib/types/chat';
import { isCustomProviderSelectionAvailable } from '$lib/agents/provider-selection.js';
import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
import { ApiError } from '$lib/api/client.js';
import { sendPermissionDecision } from '$lib/api/chats.js';
import { createClientCommandId } from '$lib/chat/conversation/client-command-id.js';
import {
	CommandOutcomeUnknownError,
	submitReplayedCommand,
} from '$lib/chat/conversation/idempotent-command.js';
import { errorDetail } from '$lib/chat/conversation/conversation-submission-helpers.js';
import { isExecutionControlAdmissionConflict } from './execution-control-conflict.js';
import type { AcceptedInputSubmissionService } from './accepted-input-submission-service.js';
import type { ConversationQueueController } from './conversation-queue-controller.svelte.js';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';
import type { ConversationExecutionSelection } from './conversation-execution-selection.js';

export interface ConversationPermissionServiceOptions {
	readonly deps: Pick<
		SessionControllerDeps,
		| 'sessions'
		| 'chatState'
		| 'agentState'
		| 'lifecycleForChat'
		| 'conversationUi'
		| 'appShell'
		| 'canSubmitToExecutor'
		| 'modelCatalogForExecutor'
	>;
	readonly acceptedInputs: AcceptedInputSubmissionService;
	readonly queue: ConversationQueueController;
	executionSelectionForChat(chatId: string): ConversationExecutionSelection | null;
}

// Owns what happens after the user answers a permission prompt, including the plan-approval
// choices that resume the turn with a different permission mode.
export class ConversationPermissionService {
	constructor(private readonly options: ConversationPermissionServiceOptions) {}

	handlePermissionDecision(
		chatId: string,
		permissionOccurrenceId: string,
		decision: PermissionDecisionPayload,
	): void {
		const { deps } = this.options;
		if (!deps.sessions.byId[chatId]) return;
		const request = deps.conversationUi
			.pendingPermissionsFor(chatId)
			.find((entry) => entry.permissionOccurrenceId === permissionOccurrenceId);
		if (!request?.control) {
			deps.chatState.appendLocalNoticeForChat(
				chatId,
				'error',
				m.chat_notice_failed_permission_decision({ detail: 'Permission request is stale' }),
			);
			return;
		}
		const command = {
			clientRequestId: createClientCommandId(),
			chatId,
			permissionOccurrenceId,
			control: request.control,
			allow: decision.allow,
			alwaysAllow: Boolean(decision.alwaysAllow),
			response: decision.response,
		};
		void submitReplayedCommand(() => sendPermissionDecision(command))
			.then(() => {
				if (!deps.sessions.byId[chatId]) return;
				deps.conversationUi.updatePendingPermissionsForChat(
					chatId,
					deps.conversationUi
						.pendingPermissionsFor(chatId)
						.filter((request) => request.permissionOccurrenceId !== permissionOccurrenceId),
				);
			})
			.catch((error) => {
				if (!deps.sessions.byId[chatId]) return;
				deps.chatState.appendLocalNoticeForChat(
					chatId,
					'error',
					permissionDecisionFailureNotice(error, (detail) =>
						m.chat_notice_failed_permission_decision({ detail }),
					),
				);
			});
	}

	handleExitPlanMode(
		chatId: string,
		permissionOccurrenceId: string,
		choice: string,
		plan: string,
	): void {
		const { deps } = this.options;
		const chat = deps.sessions.byId[chatId];
		if (!chat) return;
		if (
			(choice === 'bypass' || choice === 'approve-edits') &&
			(!deps.canSubmitToExecutor(chat.executorId ?? 'local') ||
				!isCustomProviderSelectionAvailable(
					deps.modelCatalogForExecutor(chat.executorId ?? 'local'),
					chat,
				))
		) {
			deps.chatState.appendLocalNoticeForChat(
				chatId,
				'error',
				m.chat_notice_failed_resume_plan({ detail: 'Executor or model catalog is unavailable' }),
			);
			return;
		}
		const permissionControl = deps.conversationUi
			.pendingPermissionsFor(chatId)
			.find((request) => request.permissionOccurrenceId === permissionOccurrenceId)?.control;
		deps.conversationUi.updatePendingPermissionsForChat(
			chatId,
			deps.conversationUi
				.pendingPermissionsFor(chatId)
				.filter((request) => request.permissionOccurrenceId !== permissionOccurrenceId),
		);

		const path = chat.projectPath;

		const buildApprovalMessage = () =>
			`User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan:\n${plan}`;

		const resumeWithApproval = (mode: PermissionMode) => {
			deps.conversationUi.finishPlanModeForChat(chatId);
			if (deps.sessions.selectedChatId === chatId) deps.agentState.permissionMode = mode;
			if (!path) return;
			const selection = this.options.executionSelectionForChat(chatId);
			if (!selection) {
				deps.chatState.appendLocalNoticeForChat(
					chatId,
					'error',
					m.chat_notice_failed_resume_plan({ detail: 'Chat execution settings are unavailable' }),
				);
				return;
			}

			const submission = this.options.acceptedInputs.run({
				chatId,
				transcriptViewId: deps.chatState.getCursorForChat(chatId).transcriptViewId,
				command: buildApprovalMessage(),
				permissionMode: mode,
				thinkingMode: selection.thinkingMode,
				agentSettings: selection.agentSettings,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			void submission
				.submit()
				.then(() => {
					if (!deps.sessions.byId[chatId]) return;
					deps.lifecycleForChat(chatId).beginTurn(chatId);
				})
				.catch(async (error) => {
					if (isExecutionControlAdmissionConflict(error)) {
						await this.options.queue.settleControlRefresh(
							this.options.queue.startControlRefresh(chatId),
						);
					}
					if (!deps.sessions.byId[chatId]) return;
					deps.chatState.appendLocalNoticeForChat(
						chatId,
						'error',
						error instanceof CommandOutcomeUnknownError
							? m.chat_notice_delivery_outcome_unconfirmed()
							: m.chat_notice_failed_resume_plan({ detail: errorDetail(error) }),
					);
				});
		};

		switch (choice) {
			case 'bypass-new': {
				const restoreMode = deps.conversationUi.previousPermissionModeFor(chatId) || 'default';
				deps.conversationUi.finishPlanModeForChat(chatId);
				if (deps.sessions.selectedChatId === chatId) {
					deps.agentState.permissionMode = restoreMode;
				}

				const planMessage = `Implement the following plan:\n\n${plan}`;
				deps.appShell.openNewChatDialog({ prefill: planMessage });
				break;
			}
			case 'bypass':
				resumeWithApproval('bypassPermissions');
				break;
			case 'approve-edits':
				resumeWithApproval('acceptEdits');
				break;
			case 'deny': {
				if (permissionControl) {
					const command = {
						clientRequestId: createClientCommandId(),
						chatId,
						permissionOccurrenceId,
						control: permissionControl,
						allow: false,
						alwaysAllow: false,
					};
					void submitReplayedCommand(() => sendPermissionDecision(command)).catch((error) => {
						if (!deps.sessions.byId[chatId]) return;
						deps.chatState.appendLocalNoticeForChat(
							chatId,
							'error',
							permissionDecisionFailureNotice(error, (detail) =>
								m.chat_notice_failed_deny_permission({ detail }),
							),
						);
					});
				} else {
					deps.chatState.appendLocalNoticeForChat(
						chatId,
						'error',
						m.chat_notice_failed_deny_permission({ detail: 'Permission request is stale' }),
					);
				}
				break;
			}
		}
	}
}

function permissionDecisionFailureNotice(
	error: unknown,
	failed: (detail: string) => string,
): string {
	if (
		error instanceof CommandOutcomeUnknownError ||
		(error instanceof ApiError && error.errorCode === 'PERMISSION_DECISION_OUTCOME_UNKNOWN')
	) {
		return m.chat_notice_permission_outcome_unconfirmed();
	}
	if (error instanceof ApiError && error.errorCode === 'PERMISSION_DECISION_NOT_DELIVERED') {
		return m.chat_notice_permission_not_delivered();
	}
	return failed(errorDetail(error));
}
