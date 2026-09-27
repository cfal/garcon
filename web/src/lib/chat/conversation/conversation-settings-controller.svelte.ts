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
import type { ChatSessionRecord } from '$lib/types/chat-session';
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

type SettingsPatch = Partial<
	Pick<
		ChatSessionRecord,
		| 'model'
		| 'apiProviderId'
		| 'modelEndpointId'
		| 'modelProtocol'
		| 'permissionMode'
		| 'thinkingMode'
		| 'agentSettings'
	>
>;

interface SettingMutation {
	epoch: string | undefined;
	confirmed: SettingsPatch;
	latest: symbol;
}

export class ConversationSettingsController {
	#pendingMutations = new Map<string, SettingMutation>();
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

	#changeSetting(
		chatId: string,
		setting: 'model' | 'permissionMode' | 'thinkingMode' | 'agentSettings',
		patch: SettingsPatch,
		request: (epoch: string | undefined) => Promise<SettingsPatch>,
		failureMessage: (detail: string) => string,
	): void {
		const { sessions, chatState } = this.options;
		const chat = sessions.byId[chatId];
		if (!chat) return;
		const key = `${chatId}:${setting}`;
		const epoch = chat.agentOwnershipEpoch ?? undefined;
		const previous = this.#pendingMutations.get(key);
		const token = Symbol(key);
		const mutation =
			previous && previous.epoch === epoch
				? previous
				: {
						epoch,
						confirmed: this.#readPatch(chat, patch),
						latest: token,
					};
		mutation.latest = token;
		this.#pendingMutations.set(key, mutation);
		const isCurrent = () =>
			this.#pendingMutations.get(key) === mutation &&
			mutation.latest === token &&
			!!sessions.byId[chatId] &&
			sessions.byId[chatId].agentOwnershipEpoch === epoch;
		this.#applyPatch(chatId, patch);
		this.#send(chatId, async () => {
			try {
				// Superseded successes still advance the rollback baseline for the next request.
				mutation.confirmed = await request(epoch);
				if (isCurrent()) this.#applyPatch(chatId, mutation.confirmed);
			} catch (error) {
				if (isCurrent()) {
					this.#applyPatch(chatId, mutation.confirmed);
					chatState.appendLocalNoticeForChat(chatId, 'error', failureMessage(errorDetail(error)));
				}
				throw error;
			} finally {
				try {
					if (isCurrent()) {
						// A lost reply may follow a durable write, so rollback alone is not authority.
						await sessions.quietRefreshChats();
						if (isCurrent())
							this.#applyPatch(chatId, this.#readPatch(sessions.byId[chatId], patch));
					}
				} finally {
					if (this.#pendingMutations.get(key) === mutation && mutation.latest === token) {
						this.#pendingMutations.delete(key);
					}
				}
			}
		});
	}

	#readPatch(chat: ChatSessionRecord, fields: SettingsPatch): SettingsPatch {
		return Object.fromEntries(
			Object.keys(fields).map((key) => [key, chat[key as keyof SettingsPatch]]),
		);
	}

	#applyPatch(chatId: string, patch: SettingsPatch): void {
		const { sessions, agentState, modelCatalog } = this.options;
		sessions.patchChat(chatId, patch);
		if (sessions.selectedChatId !== chatId) return;
		if ('model' in patch)
			agentState.setModelSelection({
				model: modelCatalog.selectionValueFor(
					agentState.agentId,
					patch.model ?? '',
					patch.modelEndpointId,
				),
				apiProviderId: patch.apiProviderId ?? null,
				modelEndpointId: patch.modelEndpointId ?? null,
				modelProtocol: patch.modelProtocol ?? null,
			});
		if ('permissionMode' in patch)
			agentState.permissionMode = normalizeSupportedPermissionMode(
				patch.permissionMode,
				modelCatalog.getPermissionModes(agentState.agentId),
			);
		if ('thinkingMode' in patch)
			agentState.thinkingMode = normalizeSupportedThinkingMode(
				patch.thinkingMode,
				modelCatalog.getThinkingModes(agentState.agentId),
			);
		if (patch.agentSettings) agentState.setAgentSettings(patch.agentSettings);
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

		this.#changeSetting(
			chatId,
			'model',
			selection,
			async (epoch) => {
				const response = await updateChatModel({
					chatId,
					expectedAgentOwnershipEpoch: epoch,
					...selection,
				});
				return {
					model: response.model,
					apiProviderId: response.apiProviderId ?? null,
					modelEndpointId: response.modelEndpointId ?? null,
					modelProtocol: response.modelProtocol ?? null,
				};
			},
			(detail) => m.chat_notice_failed_update_model({ detail }),
		);
	}

	handlePermissionModeChange(mode: PermissionMode): void {
		const { sessions } = this.options;
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		if (sessions.isDraft(chatId)) {
			sessions.patchDraftStartup(chatId, { permissionMode: mode });
			sessions.patchChat(chatId, { permissionMode: mode });
			return;
		}
		this.#changeSetting(
			chatId,
			'permissionMode',
			{ permissionMode: mode },
			async (epoch) => {
				const response = await updateExecutionSettings({
					chatId,
					permissionMode: mode,
					expectedAgentOwnershipEpoch: epoch,
				});
				return { permissionMode: response.permissionMode ?? mode };
			},
			(detail) => m.chat_notice_failed_update_permission_mode({ detail }),
		);
	}

	handleThinkingModeChange(mode: ThinkingMode): void {
		const { sessions } = this.options;
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		if (sessions.isDraft(chatId)) {
			sessions.patchDraftStartup(chatId, { thinkingMode: mode });
			sessions.patchChat(chatId, { thinkingMode: mode });
			return;
		}
		this.#changeSetting(
			chatId,
			'thinkingMode',
			{ thinkingMode: mode },
			async (epoch) => {
				const response = await updateExecutionSettings({
					chatId,
					thinkingMode: mode,
					expectedAgentOwnershipEpoch: epoch,
				});
				return { thinkingMode: response.thinkingMode ?? mode };
			},
			(detail) => m.chat_notice_failed_update_thinking_mode({ detail }),
		);
	}

	handleAgentSettingChange(descriptor: AgentSettingDescriptor, value: JsonValue): void {
		const { sessions, agentState } = this.options;
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		const previous = agentState.agentSettings;
		const next = withAgentSetting(previous, descriptor, value);
		if (next === previous) return;
		if (sessions.isDraft(chatId)) {
			agentState.setAgentSettings(next);
			sessions.patchDraftStartup(chatId, { agentSettings: next });
			sessions.patchChat(chatId, { agentSettings: next });
			return;
		}
		const agentSettingsPatch: JsonObject = { [descriptor.key]: value };
		this.#changeSetting(
			chatId,
			'agentSettings',
			{ agentSettings: next },
			async (epoch) => {
				const response = await updateExecutionSettings({
					chatId,
					agentSettingsPatch,
					expectedAgentOwnershipEpoch: epoch,
				});
				return { agentSettings: response.agentSettings };
			},
			(detail) => m.chat_notice_failed_update_agent_mode({ detail }),
		);
	}
}
