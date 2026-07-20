import { updateChatModel, updateExecutionSettings } from '$lib/api/chats.js';
import { withAgentSetting } from '$lib/agents/agent-settings.js';
import {
	normalizeSupportedPermissionMode,
	normalizeSupportedThinkingMode,
} from '$lib/agents/agent-modes.js';
import type { AgentSettingDescriptor } from '$shared/agent-integration';
import type { JsonObject, JsonValue } from '$shared/json';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type {
	AgentSwitchSelection,
	ConversationAgentSwitchService,
} from './conversation-agent-switch-service.js';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';
import { errorDetail } from './conversation-submission-helpers.js';
import * as m from '$lib/paraglide/messages.js';

export interface ConversationSettingsControllerOptions {
	get sessions(): Pick<
		SessionControllerDeps['sessions'],
		'selectedChatId' | 'selectedChat' | 'isDraft' | 'patchDraftStartup' | 'patchChat'
	>;
	get agentState(): Pick<
		SessionControllerDeps['agentState'],
		| 'agentId'
		| 'model'
		| 'apiProviderId'
		| 'modelEndpointId'
		| 'modelProtocol'
		| 'permissionMode'
		| 'thinkingMode'
		| 'agentSettings'
		| 'setAgentSettings'
		| 'setModelSelection'
	>;
	get modelCatalog(): Pick<
		SessionControllerDeps['modelCatalog'],
		| 'selectionFor'
		| 'selectionValueFor'
		| 'isLocalModel'
		| 'getPermissionModes'
		| 'getThinkingModes'
	>;
	get chatState(): Pick<SessionControllerDeps['chatState'], 'appendLocalNotice'>;
	get agentSwitch(): Pick<ConversationAgentSwitchService, 'switchAgent'>;
}

export class ConversationSettingsController {
	#latestAgentSettingsMutationByChatId = new Map<string, symbol>();

	constructor(private readonly options: ConversationSettingsControllerOptions) {}

	handleModelSelectionChange(next: AgentSwitchSelection): void {
		const chatId = this.options.sessions.selectedChatId;
		if (!chatId) return;
		const currentAgentId =
			this.options.sessions.selectedChat?.agentId ?? this.options.agentState.agentId;
		if (next.agentId === currentAgentId) {
			this.handleModelChange(next.modelValue);
			return;
		}
		void this.options.agentSwitch.switchAgent(chatId, next);
	}

	handleModelChange(model: string): void {
		const { sessions, agentState, modelCatalog, chatState } = this.options;
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		const agentId = agentState.agentId;
		const selection = modelCatalog.selectionFor(agentId, model);
		if (sessions.isDraft(chatId)) {
			agentState.setModelSelection({
				model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			sessions.patchDraftStartup(chatId, {
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			sessions.patchChat(chatId, {
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			return;
		}

		const currentModel = sessions.selectedChat?.model ?? agentState.model;
		const currentEndpointId =
			sessions.selectedChat?.modelEndpointId ?? agentState.modelEndpointId;
		const wasLocal = modelCatalog.isLocalModel(agentId, currentModel, currentEndpointId);
		const isLocal = modelCatalog.isLocalModel(agentId, model, selection.modelEndpointId);
		if (wasLocal !== isLocal) {
			const target = isLocal ? m.chat_model_kind_local() : m.chat_model_kind_cloud();
			chatState.appendLocalNotice(
				'error',
				m.chat_notice_cannot_switch_model_mid_session({ target, model: selection.model }),
			);
			return;
		}

		const previousModel = sessions.selectedChat?.model ?? agentState.model;
		const previousApiProviderId =
			sessions.selectedChat?.apiProviderId ?? agentState.apiProviderId;
		const previousEndpointId =
			sessions.selectedChat?.modelEndpointId ?? agentState.modelEndpointId;
		const previousProtocol =
			sessions.selectedChat?.modelProtocol ?? agentState.modelProtocol;
		agentState.setModelSelection({
			model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
		void updateChatModel({
			chatId,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		}).catch((error) => {
			agentState.setModelSelection({
				model: modelCatalog.selectionValueFor(agentId, previousModel, previousEndpointId),
				apiProviderId: previousApiProviderId ?? null,
				modelEndpointId: previousEndpointId ?? null,
				modelProtocol: previousProtocol ?? null,
			});
			sessions.patchChat(chatId, {
				model: previousModel,
				apiProviderId: previousApiProviderId ?? null,
				modelEndpointId: previousEndpointId ?? null,
				modelProtocol: previousProtocol ?? null,
			});
			chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_update_model({ detail: errorDetail(error) }),
			);
		});
		sessions.patchChat(chatId, {
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
	}

	handlePermissionModeChange(mode: PermissionMode): void {
		const { sessions, agentState, modelCatalog, chatState } = this.options;
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		if (sessions.isDraft(chatId)) {
			sessions.patchDraftStartup(chatId, { permissionMode: mode });
			sessions.patchChat(chatId, { permissionMode: mode });
			return;
		}
		const previous = normalizeSupportedPermissionMode(
			sessions.selectedChat?.permissionMode,
			modelCatalog.getPermissionModes(agentState.agentId),
		);
		sessions.patchChat(chatId, { permissionMode: mode });
		void updateExecutionSettings({ chatId, permissionMode: mode }).catch((error) => {
			agentState.permissionMode = previous;
			sessions.patchChat(chatId, { permissionMode: previous });
			chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_update_permission_mode({ detail: errorDetail(error) }),
			);
		});
	}

	handleThinkingModeChange(mode: ThinkingMode): void {
		const { sessions, agentState, modelCatalog, chatState } = this.options;
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		if (sessions.isDraft(chatId)) {
			sessions.patchDraftStartup(chatId, { thinkingMode: mode });
			sessions.patchChat(chatId, { thinkingMode: mode });
			return;
		}
		const previous = normalizeSupportedThinkingMode(
			sessions.selectedChat?.thinkingMode,
			modelCatalog.getThinkingModes(agentState.agentId),
		);
		sessions.patchChat(chatId, { thinkingMode: mode });
		void updateExecutionSettings({ chatId, thinkingMode: mode }).catch((error) => {
			agentState.thinkingMode = previous;
			sessions.patchChat(chatId, { thinkingMode: previous });
			chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_update_thinking_mode({ detail: errorDetail(error) }),
			);
		});
	}

	handleAgentSettingChange(descriptor: AgentSettingDescriptor, value: JsonValue): void {
		const { sessions, agentState, chatState } = this.options;
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		const previous = agentState.agentSettings;
		const next = withAgentSetting(previous, descriptor, value);
		if (next === previous) return;
		agentState.setAgentSettings(next);
		if (sessions.isDraft(chatId)) {
			sessions.patchDraftStartup(chatId, { agentSettings: next });
			sessions.patchChat(chatId, { agentSettings: next });
			return;
		}
		sessions.patchChat(chatId, { agentSettings: next });
		const agentSettingsPatch: JsonObject = { [descriptor.key]: value };
		const mutation = Symbol(chatId);
		this.#latestAgentSettingsMutationByChatId.set(chatId, mutation);
		void updateExecutionSettings({ chatId, agentSettingsPatch })
			.then((response) => {
				if (this.#latestAgentSettingsMutationByChatId.get(chatId) !== mutation) return;
				if (sessions.selectedChatId === chatId) {
					agentState.setAgentSettings(response.agentSettings);
				}
				sessions.patchChat(chatId, { agentSettings: response.agentSettings });
			})
			.catch((error) => {
				if (this.#latestAgentSettingsMutationByChatId.get(chatId) !== mutation) return;
				if (sessions.selectedChatId === chatId) {
					agentState.setAgentSettings(previous);
				}
				sessions.patchChat(chatId, { agentSettings: previous });
				chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_update_agent_mode({ detail: errorDetail(error) }),
				);
			})
			.finally(() => {
				if (this.#latestAgentSettingsMutationByChatId.get(chatId) === mutation) {
					this.#latestAgentSettingsMutationByChatId.delete(chatId);
				}
			});
	}
}
