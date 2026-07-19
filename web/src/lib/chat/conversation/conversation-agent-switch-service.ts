import { updateChatAgentModel } from '$lib/api/chats.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { SessionAgentId } from '$lib/types/app';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import {
	normalizeSupportedPermissionMode,
	normalizeSupportedThinkingMode,
} from '$lib/agents/agent-modes.js';
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
	agentSettings: AgentSettingsEnvelope;
	setAgentId(agentId: SessionAgentId): void;
	setAgentSettings(settings: AgentSettingsEnvelope): void;
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
	getDefaultAgentSettings(agentId: SessionAgentId): AgentSettingsEnvelope;
	getPermissionModes(agentId: SessionAgentId): readonly PermissionMode[];
	getThinkingModes(agentId: SessionAgentId): readonly ThinkingMode[];
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
	agentSettings: AgentSettingsEnvelope;
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
		deps.agentState.setAgentSettings(deps.modelCatalog.getDefaultAgentSettings(next.agentId));
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
			agentSettings: deps.modelCatalog.getDefaultAgentSettings(next.agentId),
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
			const permissionMode = normalizeSupportedPermissionMode(
				result.permissionMode,
				deps.modelCatalog.getPermissionModes(result.agentId),
			);
			const thinkingMode = normalizeSupportedThinkingMode(
				result.thinkingMode,
				deps.modelCatalog.getThinkingModes(result.agentId),
			);
			deps.agentState.permissionMode = permissionMode;
			deps.agentState.thinkingMode = thinkingMode;
			deps.agentState.setAgentSettings(result.agentSettings);
			deps.sessions.patchChat(chatId, {
				permissionMode,
				thinkingMode,
				agentSettings: result.agentSettings,
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
			agentSettings: deps.sessions.selectedChat?.agentSettings ?? deps.agentState.agentSettings,
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
		deps.agentState.permissionMode = normalizeSupportedPermissionMode(
			previous.permissionMode,
			deps.modelCatalog.getPermissionModes(previous.agentId),
		);
		deps.agentState.thinkingMode = normalizeSupportedThinkingMode(
			previous.thinkingMode,
			deps.modelCatalog.getThinkingModes(previous.agentId),
		);
		deps.agentState.setAgentSettings(previous.agentSettings);
		deps.sessions.patchChat(chatId, {
			agentId: previous.agentId,
			model: previous.model,
			apiProviderId: previous.apiProviderId ?? null,
			modelEndpointId: previous.modelEndpointId ?? null,
			modelProtocol: previous.modelProtocol ?? null,
			permissionMode: previous.permissionMode,
			thinkingMode: previous.thinkingMode,
			agentSettings: previous.agentSettings,
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
