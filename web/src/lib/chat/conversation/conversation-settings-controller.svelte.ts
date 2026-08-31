import { updateChatModel, updateExecutionSettings } from '$lib/api/chats.js';
import { withAgentSetting } from '$shared/agent-settings';
import {
	normalizeSupportedPermissionMode,
	normalizeSupportedThinkingMode,
} from '$shared/execution-defaults';
import type {
	AgentSettingDescriptor,
	AgentSettingsEnvelope,
} from '$shared/agent-integration';
import type { JsonObject, JsonValue } from '$shared/json';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type {
	AgentSwitchSelection,
	ConversationAgentSwitchService,
} from './conversation-agent-switch-service.js';
import type { SessionControllerDeps } from './conversation-session-controller.svelte.js';
import { errorDetail } from './conversation-submission-helpers.js';
import * as m from '$lib/paraglide/messages.js';
import type { ConversationExecutionDraftState } from './conversation-execution-draft-state.svelte.js';

type AgentSettingsMutationOutcome =
	| { readonly kind: 'applied' }
	| { readonly kind: 'rejected'; readonly error: unknown };

interface PendingAgentSettingsMutation {
	readonly descriptor: AgentSettingDescriptor;
	readonly value: JsonValue;
	readonly completion: Promise<AgentSettingsMutationOutcome>;
	settle(outcome: AgentSettingsMutationOutcome): void;
}

interface AgentSettingsMutationQueue {
	confirmed: AgentSettingsEnvelope;
	readonly pending: PendingAgentSettingsMutation[];
	draining: boolean;
}

export interface ConversationSettingsControllerOptions {
	get sessions(): Pick<
		SessionControllerDeps['sessions'],
		| 'selectedChatId'
		| 'selectedChat'
		| 'byId'
		| 'isDraft'
		| 'patchDraftStartup'
		| 'patchChat'
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
	get executionDraft(): Pick<
		ConversationExecutionDraftState,
		'isHandoffPending' | 'patchSelection'
	>;
}

export class ConversationSettingsController {
	#agentSettingsMutationsByChatId = new Map<string, AgentSettingsMutationQueue>();

	constructor(private readonly options: ConversationSettingsControllerOptions) {}

	handleModelSelectionChange(next: AgentSwitchSelection): void {
		const chatId = this.options.sessions.selectedChatId;
		if (!chatId) return;
		const currentAgentId = this.options.agentState.agentId;
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
		if (this.options.executionDraft.isHandoffPending) {
			agentState.setModelSelection({
				model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			this.options.executionDraft.patchSelection({
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			return;
		}
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
		if (this.options.executionDraft.isHandoffPending) {
			agentState.permissionMode = mode;
			this.options.executionDraft.patchSelection({ permissionMode: mode });
			return;
		}
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
		if (this.options.executionDraft.isHandoffPending) {
			agentState.thinkingMode = mode;
			this.options.executionDraft.patchSelection({ thinkingMode: mode });
			return;
		}
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
		const { sessions, agentState } = this.options;
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		const previous = agentState.agentSettings;
		const next = withAgentSetting(previous, descriptor, value);
		if (next === previous) return;
		agentState.setAgentSettings(next);
		if (this.options.executionDraft.isHandoffPending) {
			this.options.executionDraft.patchSelection({ agentSettings: next });
			return;
		}
		if (sessions.isDraft(chatId)) {
			sessions.patchDraftStartup(chatId, { agentSettings: next });
			sessions.patchChat(chatId, { agentSettings: next });
			return;
		}
		sessions.patchChat(chatId, { agentSettings: next });
		const queue = this.#agentSettingsMutationsByChatId.get(chatId) ?? {
			confirmed: previous,
			pending: [],
			draining: false,
		};
		queue.pending.push(pendingAgentSettingsMutation(descriptor, value));
		this.#agentSettingsMutationsByChatId.set(chatId, queue);
		void this.#drainAgentSettingsMutations(chatId, queue);
	}

	async awaitPendingAgentSettings(chatId: string): Promise<void> {
		const captured = this.#agentSettingsMutationsByChatId.get(chatId)?.pending.at(-1);
		if (!captured) return;
		const outcome = await captured.completion;
		if (outcome.kind === 'rejected') throw outcome.error;
	}

	async #drainAgentSettingsMutations(
		chatId: string,
		queue: AgentSettingsMutationQueue,
	): Promise<void> {
		if (queue.draining) return;
		queue.draining = true;
		try {
			while (queue.pending.length > 0) {
				const mutation = queue.pending[0];
				let outcome: AgentSettingsMutationOutcome;
				try {
					const agentSettingsPatch: JsonObject = {
						[mutation.descriptor.key]: mutation.value,
					};
					const response = await updateExecutionSettings({ chatId, agentSettingsPatch });
					queue.confirmed = response.agentSettings;
					outcome = { kind: 'applied' };
				} catch (error) {
					outcome = { kind: 'rejected', error };
					if (this.options.sessions.selectedChatId === chatId) {
						this.options.chatState.appendLocalNotice(
							'error',
							m.chat_notice_failed_update_agent_mode({ detail: errorDetail(error) }),
						);
					}
				}
				queue.pending.shift();
				const projected = projectAgentSettings(queue.confirmed, queue.pending);
				if (this.options.sessions.byId[chatId]) {
					this.options.sessions.patchChat(chatId, { agentSettings: projected });
					if (this.options.sessions.selectedChatId === chatId) {
						this.options.agentState.setAgentSettings(projected);
					}
				}
				mutation.settle(outcome);
			}
		} finally {
			queue.draining = false;
			if (queue.pending.length === 0) {
				this.#agentSettingsMutationsByChatId.delete(chatId);
			} else {
				void this.#drainAgentSettingsMutations(chatId, queue);
			}
		}
	}
}

function pendingAgentSettingsMutation(
	descriptor: AgentSettingDescriptor,
	value: JsonValue,
): PendingAgentSettingsMutation {
	let settle!: (outcome: AgentSettingsMutationOutcome) => void;
	const completion = new Promise<AgentSettingsMutationOutcome>((resolve) => {
		settle = resolve;
	});
	return { descriptor, value, completion, settle };
}

function projectAgentSettings(
	confirmed: AgentSettingsEnvelope,
	pending: readonly PendingAgentSettingsMutation[],
): AgentSettingsEnvelope {
	return pending.reduce(
		(envelope, mutation) => withAgentSetting(
			envelope,
			mutation.descriptor,
			mutation.value,
		),
		confirmed,
	);
}
