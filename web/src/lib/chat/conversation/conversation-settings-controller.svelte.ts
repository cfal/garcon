import { updateChatModel, updateExecutionSettings } from '$lib/api/chats.js';
import { effectiveExecutorId } from '$shared/executors';
import { withAgentSetting } from '$shared/agent-settings';
import {
	normalizeSupportedPermissionMode,
	normalizeSupportedThinkingMode,
} from '$shared/execution-defaults';
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
		| 'selectedChatId'
		| 'selectedChat'
		| 'byId'
		| 'isDraft'
		| 'patchDraftStartup'
		| 'patchChat'
		| 'quietRefreshChats'
	>;
	get agentState(): Pick<
		SessionControllerDeps['agentState'],
		| 'agentId'
		| 'executorId'
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
		| 'getModelForSelection'
		| 'getPermissionModes'
		| 'getThinkingModes'
	>;
	get chatState(): Pick<SessionControllerDeps['chatState'], 'appendLocalNoticeForChat'>;
	get agentSwitch(): Pick<ConversationAgentSwitchService, 'switchAgent'>;
}

export class ConversationSettingsController {
	#pendingMutations = new Map<string, symbol>();
	#pendingRequests = new Map<string, Promise<boolean>>();

	constructor(private readonly options: ConversationSettingsControllerOptions) {}

	hasPending(chatId: string): boolean {
		return this.#pendingRequests.has(chatId);
	}

	async settlePending(chatId: string): Promise<boolean> {
		let accepted = true;
		while (this.#pendingRequests.has(chatId)) {
			accepted = await this.#pendingRequests.get(chatId)!;
		}
		return accepted;
	}

	#send(chatId: string, request: () => Promise<void>): void {
		const previous = this.#pendingRequests.get(chatId);
		const run = async () => {
			try {
				await request();
				return true;
			} catch {
				return false;
			}
		};
		const pending = previous ? previous.then(run) : run();
		this.#pendingRequests.set(chatId, pending);
		void pending.then(() => {
			if (this.#pendingRequests.get(chatId) === pending) this.#pendingRequests.delete(chatId);
		});
	}

	#beginMutation(chatId: string, setting: string) {
		const key = `${chatId}:${setting}`;
		const mutation = Symbol(key);
		const epoch = this.options.sessions.byId[chatId]?.agentOwnershipEpoch ?? undefined;
		this.#pendingMutations.set(key, mutation);
		return {
			epoch,
			isCurrent: () =>
				this.#pendingMutations.get(key) === mutation &&
				this.options.sessions.byId[chatId]?.agentOwnershipEpoch === epoch,
			finish: () => {
				if (this.#pendingMutations.get(key) === mutation) this.#pendingMutations.delete(key);
			},
		};
	}

	handleModelSelectionChange(next: AgentSwitchSelection): void {
		const chatId = this.options.sessions.selectedChatId;
		if (!chatId) return;
		const currentAgentId = this.options.agentState.agentId;
		if (
			next.agentId === currentAgentId &&
			effectiveExecutorId(next.executorId) ===
				effectiveExecutorId(this.options.agentState.executorId)
		) {
			this.handleModelChange(next.modelValue);
			return;
		}
		void this.options.agentSwitch.switchAgent(chatId, next).catch((error) => {
			this.options.chatState.appendLocalNoticeForChat(chatId, 'error', errorDetail(error));
		});
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
		const currentEndpointId = sessions.selectedChat?.modelEndpointId ?? agentState.modelEndpointId;
		const previousSelection = modelCatalog.getModelForSelection(
			agentId,
			currentModel,
			currentEndpointId,
		);
		const wasLocal = modelCatalog.isLocalModel(agentId, currentModel, currentEndpointId);
		const isLocal = modelCatalog.isLocalModel(agentId, model, selection.modelEndpointId);
		// Unavailable selections need the server's historical classification.
		if (previousSelection && wasLocal !== isLocal) {
			const target = isLocal ? m.chat_model_kind_local() : m.chat_model_kind_cloud();
			chatState.appendLocalNoticeForChat(
				chatId,
				'error',
				m.chat_notice_cannot_switch_model_mid_session({ target, model: selection.model }),
			);
			return;
		}

		const previousModel = sessions.selectedChat?.model ?? agentState.model;
		const previousApiProviderId = sessions.selectedChat?.apiProviderId ?? agentState.apiProviderId;
		const previousEndpointId = sessions.selectedChat?.modelEndpointId ?? agentState.modelEndpointId;
		const previousProtocol = sessions.selectedChat?.modelProtocol ?? agentState.modelProtocol;
		agentState.setModelSelection({
			model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
		const mutation = this.#beginMutation(chatId, 'model');
		this.#send(chatId, () =>
			updateChatModel({
				chatId,
				expectedAgentOwnershipEpoch: mutation.epoch,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			})
				.then(async () => {
					if (mutation.isCurrent()) await sessions.quietRefreshChats();
				})
				.catch((error) => {
					if (!mutation.isCurrent()) return;
					if (sessions.selectedChatId === chatId)
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
					chatState.appendLocalNoticeForChat(
						chatId,
						'error',
						m.chat_notice_failed_update_model({ detail: errorDetail(error) }),
					);
					throw error;
				})
				.finally(mutation.finish),
		);
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
		const mutation = this.#beginMutation(chatId, 'permission');
		this.#send(chatId, () =>
			updateExecutionSettings({
				chatId,
				permissionMode: mode,
				expectedAgentOwnershipEpoch: mutation.epoch,
			})
				.then(async () => {
					if (mutation.isCurrent()) await sessions.quietRefreshChats();
				})
				.catch((error) => {
					if (!mutation.isCurrent()) return;
					if (sessions.selectedChatId === chatId) agentState.permissionMode = previous;
					sessions.patchChat(chatId, { permissionMode: previous });
					chatState.appendLocalNoticeForChat(
						chatId,
						'error',
						m.chat_notice_failed_update_permission_mode({ detail: errorDetail(error) }),
					);
					throw error;
				})
				.finally(mutation.finish),
		);
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
		const mutation = this.#beginMutation(chatId, 'thinking');
		this.#send(chatId, () =>
			updateExecutionSettings({
				chatId,
				thinkingMode: mode,
				expectedAgentOwnershipEpoch: mutation.epoch,
			})
				.then(async () => {
					if (mutation.isCurrent()) await sessions.quietRefreshChats();
				})
				.catch((error) => {
					if (!mutation.isCurrent()) return;
					if (sessions.selectedChatId === chatId) agentState.thinkingMode = previous;
					sessions.patchChat(chatId, { thinkingMode: previous });
					chatState.appendLocalNoticeForChat(
						chatId,
						'error',
						m.chat_notice_failed_update_thinking_mode({ detail: errorDetail(error) }),
					);
					throw error;
				})
				.finally(mutation.finish),
		);
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
		const mutation = this.#beginMutation(chatId, 'agentSettings');
		this.#send(chatId, () =>
			updateExecutionSettings({
				chatId,
				agentSettingsPatch,
				expectedAgentOwnershipEpoch: mutation.epoch,
			})
				.then(async (response) => {
					if (!mutation.isCurrent()) return;
					if (sessions.selectedChatId === chatId) {
						agentState.setAgentSettings(response.agentSettings);
					}
					sessions.patchChat(chatId, { agentSettings: response.agentSettings });
					await sessions.quietRefreshChats();
				})
				.catch((error) => {
					if (!mutation.isCurrent()) return;
					if (sessions.selectedChatId === chatId) {
						agentState.setAgentSettings(previous);
					}
					sessions.patchChat(chatId, { agentSettings: previous });
					chatState.appendLocalNoticeForChat(
						chatId,
						'error',
						m.chat_notice_failed_update_agent_mode({ detail: errorDetail(error) }),
					);
					throw error;
				})
				.finally(mutation.finish),
		);
	}
}
