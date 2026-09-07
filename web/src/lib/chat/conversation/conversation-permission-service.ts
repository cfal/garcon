import * as m from '$lib/paraglide/messages.js';
import type { PermissionMode } from '$lib/types/chat';
import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
import { sendPermissionDecision } from '$lib/api/chats.js';
import { createClientCommandId } from '$lib/chat/conversation/client-command-id.js';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';
import { errorDetail } from '$lib/chat/conversation/conversation-submission-helpers.js';
import { isExecutionControlAdmissionConflict } from './execution-control-conflict.js';
import type { AcceptedInputSubmissionService } from './accepted-input-submission-service.js';
import type { ConversationQueueController } from './conversation-queue-controller.svelte.js';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';
import type { ConversationExecutionSelection } from './conversation-execution-draft-state.svelte.js';

export interface ConversationPermissionServiceOptions {
	readonly deps: Pick<
		SessionControllerDeps,
		'sessions' | 'chatState' | 'agentState' | 'lifecycleForChat' | 'conversationUi' | 'appShell'
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
		void sendPermissionDecision({
			clientRequestId: createClientCommandId(),
			chatId,
			permissionOccurrenceId,
			control: request.control,
			allow: decision.allow,
			alwaysAllow: Boolean(decision.alwaysAllow),
			response: decision.response,
		})
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
					m.chat_notice_failed_permission_decision({ detail: errorDetail(error) }),
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
					void sendPermissionDecision({
						clientRequestId: createClientCommandId(),
						chatId,
						permissionOccurrenceId,
						control: permissionControl,
						allow: false,
						alwaysAllow: false,
					}).catch((error) => {
						if (!deps.sessions.byId[chatId]) return;
						deps.chatState.appendLocalNoticeForChat(
							chatId,
							'error',
							m.chat_notice_failed_deny_permission({ detail: errorDetail(error) }),
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
