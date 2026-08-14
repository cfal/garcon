import * as m from '$lib/paraglide/messages.js';
import type { ApiProtocol } from '$shared/api-providers';
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

export interface ConversationPermissionServiceOptions {
	readonly deps: Pick<
		SessionControllerDeps,
		'sessions' | 'chatState' | 'agentState' | 'lifecycle' | 'conversationUi' | 'appShell'
	>;
	readonly acceptedInputs: AcceptedInputSubmissionService;
	readonly queue: ConversationQueueController;
	executionModelSelection(): {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	};
}

// Owns what happens after the user answers a permission prompt, including the plan-approval
// choices that resume the turn with a different permission mode.
export class ConversationPermissionService {
	constructor(private readonly options: ConversationPermissionServiceOptions) {}

	handlePermissionDecision(permissionRequestId: string, decision: PermissionDecisionPayload): void {
		const { deps } = this.options;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		const request = deps.conversationUi.pendingPermissionRequests.find(
			(entry) => entry.permissionRequestId === permissionRequestId,
		);
		if (!request?.control) {
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_permission_decision({ detail: 'Permission request is stale' }),
			);
			return;
		}
		void sendPermissionDecision({
			clientRequestId: createClientCommandId(),
			chatId,
			permissionRequestId,
			control: request.control,
			allow: decision.allow,
			alwaysAllow: Boolean(decision.alwaysAllow),
			response: decision.response,
		})
			.then(() => {
				deps.conversationUi.setPendingPermissionRequests(
					deps.conversationUi.pendingPermissionRequests.filter(
						(r) => r.permissionRequestId !== permissionRequestId,
					),
				);
			})
			.catch((error) => {
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_permission_decision({ detail: errorDetail(error) }),
				);
			});
	}

	handleExitPlanMode(permissionRequestId: string, choice: string, plan: string): void {
		const { deps } = this.options;
		const permissionControl = deps.conversationUi.pendingPermissionRequests.find(
			(request) => request.permissionRequestId === permissionRequestId,
		)?.control;
		deps.conversationUi.setPendingPermissionRequests(
			deps.conversationUi.pendingPermissionRequests.filter(
				(r) => r.permissionRequestId !== permissionRequestId,
			),
		);

		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		const path = deps.sessions.selectedChat?.projectPath;

		const buildApprovalMessage = () =>
			`User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan:\n${plan}`;

		const resumeWithApproval = (mode: PermissionMode) => {
			deps.conversationUi.setPreviousPermissionMode(null);
			deps.agentState.permissionMode = mode;
			if (!chatId || !path) return;
			const selection = this.options.executionModelSelection();

			const submission = this.options.acceptedInputs.run({
				chatId,
				transcriptViewId: deps.chatState.getCursor().transcriptViewId,
				command: buildApprovalMessage(),
				permissionMode: mode,
				thinkingMode: deps.agentState.thinkingMode,
				agentSettings: deps.agentState.agentSettings,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			void submission
				.submit()
				.then(() => {
					deps.lifecycle.beginTurn(chatId);
				})
				.catch(async (error) => {
					if (isExecutionControlAdmissionConflict(error)) {
						await this.options.queue.settleControlRefresh(this.options.queue.startControlRefresh(chatId));
					}
					deps.chatState.appendLocalNotice(
						'error',
						error instanceof CommandOutcomeUnknownError
							? m.chat_notice_delivery_outcome_unconfirmed()
							: m.chat_notice_failed_resume_plan({ detail: errorDetail(error) }),
					);
				});
		};

		switch (choice) {
			case 'bypass-new': {
				const restoreMode = deps.conversationUi.previousPermissionMode || 'default';
				deps.conversationUi.setPreviousPermissionMode(null);
				deps.agentState.permissionMode = restoreMode;

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
				if (chatId && permissionControl) {
					void sendPermissionDecision({
						clientRequestId: createClientCommandId(),
						chatId,
						permissionRequestId,
						control: permissionControl,
						allow: false,
						alwaysAllow: false,
					}).catch((error) => {
						deps.chatState.appendLocalNotice(
							'error',
							m.chat_notice_failed_deny_permission({ detail: errorDetail(error) }),
						);
					});
				} else if (chatId) {
					deps.chatState.appendLocalNotice(
						'error',
						m.chat_notice_failed_deny_permission({ detail: 'Permission request is stale' }),
					);
				}
				break;
			}
		}
	}
}
