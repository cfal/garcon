import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import type { SessionAgentId } from '$lib/types/app';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import { effectiveExecutorId } from '$shared/executors';
import type { ResolvedModelSelection } from '$shared/start-selection';
import { resolveConversationModelSelection } from './conversation-model-selection.js';
import type { ExecutorHandoffDestination, ExecutorHandoffModel } from './executor-handoff-project.svelte.js';
import type {
	ConversationExecutionDraftState,
	ConversationExecutionSelection,
} from './conversation-execution-draft-state.svelte.js';

interface AgentSwitchSessions {
	selectedChat: ChatSessionRecord | null;
	isDraft(chatId: string): boolean;
	patchDraftStartup(chatId: string, patch: Partial<ChatStartupConfig>): void;
	patchChat(chatId: string, patch: Partial<ChatSessionRecord>): void;
}

interface AgentSwitchState extends ResolvedModelSelection {
	executorId: string;
	projectPath: string;
	agentId: SessionAgentId;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
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
	): ResolvedModelSelection | null;
	selectionValueFor(
		agentId: SessionAgentId,
		model: string,
		modelEndpointId?: string | null,
	): string;
}

export interface ConversationAgentSwitchDeps {
	sessions: AgentSwitchSessions;
	agentState: AgentSwitchState;
	modelCatalog: AgentSwitchModelCatalog;
	modelCatalogForExecutor(executorId: string): AgentSwitchModelCatalog;
	chooseDestination(
		chatId: string,
		executorId: string,
		path: string,
		model: ExecutorHandoffModel,
	): Promise<ExecutorHandoffDestination | null>;
	executionDraft: Pick<
		ConversationExecutionDraftState,
		'replaceSelection' | 'replaceDestination' | 'resetToDurable' | 'isHandoffPending'
	>;
	getExecutionDefaults(
		agentId: SessionAgentId,
		executorId?: string,
	): Pick<ConversationExecutionSelection, 'permissionMode' | 'thinkingMode' | 'agentSettings'>;
}

export interface AgentSwitchSelection {
	executorId?: string;
	agentId: SessionAgentId;
	modelValue: string;
}

export class ConversationAgentSwitchService {
	constructor(private readonly deps: ConversationAgentSwitchDeps) {}

	async switchAgent(chatId: string, next: AgentSwitchSelection): Promise<void> {
		const durable = this.deps.sessions.selectedChat;
		if (!durable || durable.id !== chatId) return;
		const executorId = effectiveExecutorId(next.executorId ?? durable.executorId);
		if (
			!this.deps.sessions.isDraft(chatId) &&
			next.agentId === durable.agentId &&
			executorId === effectiveExecutorId(durable.executorId)
		) {
			const selection = this.deps.executionDraft.resetToDurable();
			if (selection) this.#applyAgentState(selection);
			return;
		}

		let agentId = next.agentId;
		let modelValue = next.modelValue;
		let projectPath = this.deps.executionDraft.isHandoffPending
			? this.deps.agentState.projectPath
			: durable.projectPath;
		let model: ResolvedModelSelection;
		let confirmedDestination = false;
		if (executorId !== effectiveExecutorId(this.deps.agentState.executorId)) {
			if (executorId === effectiveExecutorId(durable.executorId)) projectPath = durable.projectPath;
			const current = this.deps.agentState;
			const catalog = this.deps.modelCatalogForExecutor(current.executorId);
			if (agentId === current.agentId && modelValue === current.model) {
				model = resolveConversationModelSelection(current, catalog);
			} else {
				model = catalog.selectionFor(agentId, modelValue) ?? {
					model: modelValue,
					apiProviderId: null,
					modelEndpointId: null,
					modelProtocol: null,
				};
			}
			const destination = await this.deps.chooseDestination(chatId, executorId, projectPath, {
				agentId,
				...model,
			});
			if (!destination) return;
			confirmedDestination = true;
			projectPath = destination.projectPath;
			model = destination.selection;
			agentId = destination.selection.agentId;
			modelValue = this.deps
				.modelCatalogForExecutor(executorId)
				.selectionValueFor(agentId, model.model, model.modelEndpointId);
		} else {
			const resolved = this.deps.modelCatalogForExecutor(executorId).selectionFor(agentId, modelValue);
			if (!resolved) return;
			model = resolved;
		}
		if (
			!projectPath ||
			this.deps.sessions.selectedChat?.id !== chatId ||
			this.deps.sessions.selectedChat.agentOwnershipEpoch !== durable.agentOwnershipEpoch
		)
			return;
		if (
			!this.deps.sessions.isDraft(chatId) &&
			agentId === durable.agentId &&
			executorId === effectiveExecutorId(durable.executorId)
		) {
			const selection = this.deps.executionDraft.resetToDurable();
			if (selection) this.#applyAgentState(selection);
			return;
		}
		const defaults = this.deps.getExecutionDefaults(agentId, executorId);
		const selection: ConversationExecutionSelection = {
			executorId,
			projectPath,
			agentId,
			model: model.model,
			apiProviderId: model.apiProviderId,
			modelEndpointId: model.modelEndpointId,
			modelProtocol: model.modelProtocol,
			permissionMode: defaults.permissionMode,
			thinkingMode: defaults.thinkingMode,
			agentSettings: defaults.agentSettings,
		};

		this.#applyAgentState(selection, modelValue);
		if (this.deps.sessions.isDraft(chatId)) {
			this.deps.sessions.patchDraftStartup(chatId, { ...selection, executorId });
			this.deps.sessions.patchChat(chatId, selection);
			return;
		}
		if (confirmedDestination) this.deps.executionDraft.replaceDestination(selection);
		else this.deps.executionDraft.replaceSelection(selection);
	}

	#applyAgentState(selection: ConversationExecutionSelection, modelValue?: string): void {
		const { agentState } = this.deps;
		agentState.executorId = effectiveExecutorId(selection.executorId);
		agentState.projectPath = selection.projectPath ?? '';
		const modelCatalog = this.deps.modelCatalogForExecutor(agentState.executorId);
		agentState.setAgentId(selection.agentId);
		agentState.setModelSelection({
			model:
				modelValue ??
				modelCatalog.selectionValueFor(
					selection.agentId,
					selection.model,
					selection.modelEndpointId,
				),
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
		agentState.permissionMode = selection.permissionMode;
		agentState.thinkingMode = selection.thinkingMode;
		agentState.setAgentSettings(selection.agentSettings);
	}
}
