import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import type { SessionAgentId } from '$lib/types/app';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import { effectiveNodeId } from '$shared/execution-nodes';
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

interface AgentSwitchState {
	nodeId: string;
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
}

export interface ConversationAgentSwitchDeps {
	sessions: AgentSwitchSessions;
	agentState: AgentSwitchState;
	modelCatalog: AgentSwitchModelCatalog;
	modelCatalogForNode(nodeId: string): AgentSwitchModelCatalog;
	chooseProjectPath(chatId: string, nodeId: string, path: string): Promise<string | null>;
	executionDraft: Pick<
		ConversationExecutionDraftState,
		'replaceSelection' | 'resetToDurable'
	>;
	getExecutionDefaults(agentId: SessionAgentId, nodeId?: string): Pick<
		ConversationExecutionSelection,
		'permissionMode' | 'thinkingMode' | 'agentSettings'
	>;
}

export interface AgentSwitchSelection {
	nodeId?: string;
	agentId: SessionAgentId;
	modelValue: string;
}

export class ConversationAgentSwitchService {
	constructor(private readonly deps: ConversationAgentSwitchDeps) {}

	async switchAgent(chatId: string, next: AgentSwitchSelection): Promise<void> {
		const durable = this.deps.sessions.selectedChat;
		if (!durable || durable.id !== chatId) return;
		const nodeId = effectiveNodeId(next.nodeId ?? durable.nodeId);
		if (!this.deps.sessions.isDraft(chatId) && next.agentId === durable.agentId && nodeId === effectiveNodeId(durable.nodeId)) {
			const selection = this.deps.executionDraft.resetToDurable();
			if (selection) this.#applyAgentState(selection);
			return;
		}

		const projectPath = nodeId === effectiveNodeId(durable.nodeId) ? durable.projectPath
			: await this.deps.chooseProjectPath(chatId, nodeId, durable.projectPath);
		if (!projectPath || this.deps.sessions.selectedChat?.id !== chatId
			|| this.deps.sessions.selectedChat.agentOwnershipEpoch !== durable.agentOwnershipEpoch) return;
		const catalog = this.deps.modelCatalogForNode(nodeId);
		const model = catalog.selectionFor(next.agentId, next.modelValue);
		const defaults = this.deps.getExecutionDefaults(next.agentId, nodeId);
		const selection: ConversationExecutionSelection = {
			nodeId,
			projectPath,
			agentId: next.agentId,
			model: model.model,
			apiProviderId: model.apiProviderId,
			modelEndpointId: model.modelEndpointId,
			modelProtocol: model.modelProtocol,
			permissionMode: defaults.permissionMode,
			thinkingMode: defaults.thinkingMode,
			agentSettings: defaults.agentSettings,
		};

		this.#applyAgentState(selection, next.modelValue);
		if (this.deps.sessions.isDraft(chatId)) {
			this.deps.sessions.patchDraftStartup(chatId, { ...selection, nodeId });
			this.deps.sessions.patchChat(chatId, selection);
			return;
		}
		this.deps.executionDraft.replaceSelection(selection);
	}

	#applyAgentState(selection: ConversationExecutionSelection, modelValue?: string): void {
		const { agentState } = this.deps;
		agentState.nodeId = effectiveNodeId(selection.nodeId);
		agentState.projectPath = selection.projectPath ?? '';
		const modelCatalog = this.deps.modelCatalogForNode(agentState.nodeId);
		agentState.setAgentId(selection.agentId);
		agentState.setModelSelection({
			model: modelValue ?? modelCatalog.selectionValueFor(
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
