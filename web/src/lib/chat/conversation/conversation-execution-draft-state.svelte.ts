import type { AgentHandoffRequest, AgentHandoffTarget } from '$shared/chat-command-contracts';
import { effectiveNodeId } from '$shared/execution-nodes';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import type { PermissionMode, ThinkingMode } from '$shared/chat-modes';
import { cloneAgentSettings } from '$shared/agent-settings';

export interface ConversationExecutionSelection extends AgentHandoffTarget {
	agentId: string;
	model: string;
	apiProviderId: string | null;
	modelEndpointId: string | null;
	modelProtocol: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	agentSettings: AgentSettingsEnvelope;
}

export interface ConversationExecutionProjection {
	nodeId?: string | null;
	projectPath?: string;
	agentId: string;
	model: string | null;
	apiProviderId?: string | null;
	modelEndpointId?: string | null;
	modelProtocol?: ApiProtocol | null;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	agentSettings: AgentSettingsEnvelope;
}

export interface ConversationExecutionDraftStateOptions {
	get activeChatId(): string | null;
	get durableSelection(): ConversationExecutionSelection | null;
}

export class ConversationExecutionDraftState {
	selection = $state<ConversationExecutionSelection | null>(null);
	#hasStagedSelection = $state(false);
	#chatId: string | null = null;
	#observedDurableSelection: ConversationExecutionSelection | null = null;
	#location: 'chat' | 'destination' = 'chat';

	readonly isHandoffPending = $derived.by(() => {
		const durable = this.options.durableSelection;
		return (
			this.#hasStagedSelection &&
			this.options.activeChatId === this.#chatId &&
			this.selection !== null &&
			durable !== null &&
			!sameExecutionOwner(this.selection, durable)
		);
	});

	constructor(private readonly options: ConversationExecutionDraftStateOptions) {}

	activate(chatId: string | null): ConversationExecutionSelection | null {
		const durable =
			chatId && this.options.activeChatId === chatId ? this.options.durableSelection : null;
		this.#chatId = chatId;
		this.#hasStagedSelection = false;
		this.#location = 'chat';
		this.selection = durable ? cloneSelection(durable) : null;
		this.#observedDurableSelection = this.selection;
		return this.selection;
	}

	reconcileDurable(): ConversationExecutionSelection | null {
		if (this.options.activeChatId !== this.#chatId) return null;
		const durable = this.options.durableSelection;
		const previous = this.#observedDurableSelection;
		if (!durable || !previous) return null;
		this.#observedDurableSelection = cloneSelection(durable);
		if (this.#hasStagedSelection) {
			if (this.selection && !sameExecutionOwner(this.selection, durable)) {
				if (this.#location === 'destination') return null;
				if (effectiveNodeId(this.selection.nodeId) === effectiveNodeId(durable.nodeId)) {
					if (this.selection.projectPath === durable.projectPath) return null;
					this.selection = { ...this.selection, projectPath: durable.projectPath };
					return this.selection;
				}
			}
		} else if (
			sameExecutionOwner(previous, durable) &&
			previous.projectPath === durable.projectPath
		) {
			return null;
		}
		return this.resetToDurable();
	}

	replaceSelection(selection: ConversationExecutionSelection): void {
		const keepsDestination =
			this.#chatId === this.options.activeChatId &&
			this.#hasStagedSelection &&
			this.#location === 'destination' &&
			this.selection !== null &&
			effectiveNodeId(selection.nodeId) === effectiveNodeId(this.selection.nodeId);
		this.#replaceSelection(
			selection,
			keepsDestination ||
				effectiveNodeId(selection.nodeId) !== effectiveNodeId(this.options.durableSelection?.nodeId)
				? 'destination'
				: 'chat',
		);
	}

	replaceDestination(selection: ConversationExecutionSelection): void {
		this.#replaceSelection(selection, 'destination');
	}

	#replaceSelection(
		selection: ConversationExecutionSelection,
		location: 'chat' | 'destination',
	): void {
		const chatId = this.options.activeChatId;
		const durable = this.options.durableSelection;
		if (!chatId || !durable) return;
		this.#chatId = chatId;
		this.#observedDurableSelection = cloneSelection(durable);
		if (sameExecutionOwner(selection, durable)) {
			this.resetToDurable();
			return;
		}
		this.selection = cloneSelection(selection);
		this.#hasStagedSelection = true;
		this.#location = location;
	}

	patchSelection(patch: Partial<ConversationExecutionSelection>): void {
		this.reconcileDurable();
		if (!this.selection || !this.isHandoffPending) return;
		this.replaceSelection({ ...this.selection, ...patch });
	}

	resetToDurable(): ConversationExecutionSelection | null {
		return this.activate(this.options.activeChatId);
	}

	acceptDurable(selection: ConversationExecutionSelection): void {
		this.selection = cloneSelection(selection);
		this.#hasStagedSelection = false;
		this.#location = 'chat';
		this.#observedDurableSelection = this.selection;
	}

	handoffRequest(expectedAgentOwnershipEpoch: string): AgentHandoffRequest | null {
		this.reconcileDurable();
		if (!this.isHandoffPending || !this.selection) return null;
		if (!expectedAgentOwnershipEpoch.trim()) {
			throw new Error('The selected chat has no ownership epoch for an agent handoff');
		}
		const target = cloneSelection(this.selection);
		if (this.#location === 'chat') delete target.projectPath;
		return {
			target,
			expectedAgentOwnershipEpoch,
		};
	}
}

export function cloneSelection(
	selection: ConversationExecutionSelection,
): ConversationExecutionSelection {
	return {
		...selection,
		agentSettings: cloneAgentSettings(selection.agentSettings),
	};
}

export function executionSelectionFromProjection(
	projection: ConversationExecutionProjection | null | undefined,
): ConversationExecutionSelection | null {
	if (!projection?.model || projection.agentSettings.ownerId !== projection.agentId) return null;
	return cloneSelection({
		nodeId: effectiveNodeId(projection.nodeId),
		projectPath: projection.projectPath,
		agentId: projection.agentId,
		model: projection.model,
		apiProviderId: projection.apiProviderId ?? null,
		modelEndpointId: projection.modelEndpointId ?? null,
		modelProtocol: projection.modelProtocol ?? null,
		permissionMode: projection.permissionMode,
		thinkingMode: projection.thinkingMode,
		agentSettings: projection.agentSettings,
	});
}

function sameExecutionOwner(left: AgentHandoffTarget, right: AgentHandoffTarget): boolean {
	return (
		left.agentId === right.agentId && effectiveNodeId(left.nodeId) === effectiveNodeId(right.nodeId)
	);
}
