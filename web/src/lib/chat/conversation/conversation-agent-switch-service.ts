import { updateChatAgentModel } from '$lib/api/chats.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { SessionAgentId } from '$lib/types/app';
import type {
	AmpAgentMode,
	ClaudeThinkingMode,
	PermissionMode,
	ThinkingMode,
} from '$lib/types/chat';
import type { ApiProtocol } from '$shared/api-providers';
import { normalizeThinkingModeForAgent } from '$shared/chat-modes';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { errorDetail } from '$lib/chat/conversation/conversation-submission-helpers.js';
import * as m from '$lib/paraglide/messages.js';

interface AgentSwitchSessions {
	selectedChat: ChatSessionRecord | null;
	isDraft(chatId: string): boolean;
	patchChat(chatId: string, patch: Partial<ChatSessionRecord>): void;
}

interface AgentSwitchState {
	agentId: SessionAgentId;
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	claudeThinkingMode: ClaudeThinkingMode;
	ampAgentMode: AmpAgentMode;
	setAgentId(agentId: SessionAgentId): void;
	setModelSelection(selection: {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	}): void;
}

interface AgentSwitchModelCatalog {
	selectionFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	};
	selectionValueFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): string;
	getAgentLabel(agentId: SessionAgentId): string;
}

export interface ConversationAgentSwitchDeps {
	sessions: AgentSwitchSessions;
	chatState: { appendLocalNotice(noticeType: LocalNoticeType, content: string): void };
	agentState: AgentSwitchState;
	modelCatalog: AgentSwitchModelCatalog;
	reloadTranscript?(chatId: string): Promise<void>;
}

export interface AgentSwitchSelection {
	agentId: SessionAgentId;
	modelValue: string;
}

interface PreviousAgentSelection {
	agentId: SessionAgentId;
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	claudeThinkingMode: ClaudeThinkingMode;
	ampAgentMode: AmpAgentMode;
}

export class ConversationAgentSwitchService {
	constructor(private readonly deps: ConversationAgentSwitchDeps) {}

	async switchAgent(chatId: string, next: AgentSwitchSelection): Promise<void> {
		const { deps } = this;
		if (deps.sessions.isDraft(chatId)) {
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_switch_agent({
					agent: deps.modelCatalog.getAgentLabel(next.agentId),
					detail: m.chat_notice_cannot_switch_agent_draft(),
				}),
			);
			return;
		}

		const previous = this.#previousSelection();
		const selection = deps.modelCatalog.selectionFor(next.agentId, next.modelValue);

		deps.agentState.setAgentId(next.agentId);
		deps.agentState.setModelSelection({
			model: next.modelValue,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
		deps.sessions.patchChat(chatId, {
			agentId: next.agentId,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});

		try {
			const result = await updateChatAgentModel({
				chatId,
				agentId: next.agentId,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			deps.agentState.permissionMode = result.permissionMode;
			deps.agentState.thinkingMode = normalizeThinkingModeForAgent(
				result.agentId,
				result.thinkingMode,
			);
			deps.agentState.claudeThinkingMode = result.claudeThinkingMode;
			deps.agentState.ampAgentMode = result.ampAgentMode;
			deps.sessions.patchChat(chatId, {
				permissionMode: result.permissionMode,
				thinkingMode: result.thinkingMode,
				claudeThinkingMode: result.claudeThinkingMode,
				ampAgentMode: result.ampAgentMode,
			});
		} catch (error) {
			this.#rollback(chatId, previous, next, error);
			return;
		}

		try {
			await deps.reloadTranscript?.(chatId);
		} catch {
			// The boundary appears on the next transcript rebuild instead.
		}
	}

	#previousSelection(): PreviousAgentSelection {
		const { deps } = this;
		return {
			agentId: deps.sessions.selectedChat?.agentId ?? deps.agentState.agentId,
			model: deps.sessions.selectedChat?.model ?? deps.agentState.model,
			apiProviderId: deps.sessions.selectedChat?.apiProviderId ?? deps.agentState.apiProviderId,
			modelEndpointId:
				deps.sessions.selectedChat?.modelEndpointId ?? deps.agentState.modelEndpointId,
			modelProtocol: deps.sessions.selectedChat?.modelProtocol ?? deps.agentState.modelProtocol,
			permissionMode: deps.sessions.selectedChat?.permissionMode ?? deps.agentState.permissionMode,
			thinkingMode: deps.sessions.selectedChat?.thinkingMode ?? deps.agentState.thinkingMode,
			claudeThinkingMode:
				deps.sessions.selectedChat?.claudeThinkingMode ?? deps.agentState.claudeThinkingMode,
			ampAgentMode: deps.sessions.selectedChat?.ampAgentMode ?? deps.agentState.ampAgentMode,
		};
	}

	#rollback(
		chatId: string,
		previous: PreviousAgentSelection,
		next: AgentSwitchSelection,
		error: unknown,
	): void {
		const { deps } = this;
		deps.agentState.setAgentId(previous.agentId);
		deps.agentState.setModelSelection({
			model: deps.modelCatalog.selectionValueFor(
				previous.agentId,
				previous.model,
				previous.modelEndpointId,
			),
			apiProviderId: previous.apiProviderId ?? null,
			modelEndpointId: previous.modelEndpointId ?? null,
			modelProtocol: previous.modelProtocol ?? null,
		});
		deps.agentState.permissionMode = previous.permissionMode;
		deps.agentState.thinkingMode = normalizeThinkingModeForAgent(
			previous.agentId,
			previous.thinkingMode,
		);
		deps.agentState.claudeThinkingMode = previous.claudeThinkingMode;
		deps.agentState.ampAgentMode = previous.ampAgentMode;
		deps.sessions.patchChat(chatId, {
			agentId: previous.agentId,
			model: previous.model,
			apiProviderId: previous.apiProviderId ?? null,
			modelEndpointId: previous.modelEndpointId ?? null,
			modelProtocol: previous.modelProtocol ?? null,
			permissionMode: previous.permissionMode,
			thinkingMode: previous.thinkingMode,
			claudeThinkingMode: previous.claudeThinkingMode,
			ampAgentMode: previous.ampAgentMode,
		});
		deps.chatState.appendLocalNotice(
			'error',
			m.chat_notice_failed_switch_agent({
				agent: deps.modelCatalog.getAgentLabel(next.agentId),
				detail: errorDetail(error),
			}),
		);
	}
}
