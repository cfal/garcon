import type { AgentHandoffRequest, AgentHandoffTarget } from '$shared/chat-command-contracts';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ApiProtocol } from '$shared/api-providers';
import {
	normalizePermissionMode,
	normalizeThinkingMode,
	type PermissionMode,
	type ThinkingMode,
} from '$shared/chat-modes';
import { cloneAgentSettings } from '$shared/agent-settings';
import { isRecord } from '$shared/json';
import {
	chatExecutionDraftStorageKey,
	getLocalStorageItem,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence.js';

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

	readonly isHandoffPending = $derived.by(() => {
		const durable = this.options.durableSelection;
		return (
			this.options.activeChatId !== null
			&& this.selection !== null
			&& durable !== null
			&& this.selection.agentId !== durable.agentId
		);
	});

	constructor(private readonly options: ConversationExecutionDraftStateOptions) {}

	activate(chatId: string): ConversationExecutionSelection | null {
		const durable = this.options.durableSelection;
		if (!durable || this.options.activeChatId !== chatId) {
			this.selection = null;
			return null;
		}
		const stored = parseStoredSelection(getLocalStorageItem(chatExecutionDraftStorageKey(chatId)));
		if (!stored || stored.agentId === durable.agentId) {
			removeLocalStorageItem(chatExecutionDraftStorageKey(chatId));
			this.selection = cloneSelection(durable);
			return this.selection;
		}
		this.selection = stored;
		return this.selection;
	}

	replaceSelection(selection: ConversationExecutionSelection): void {
		const chatId = this.options.activeChatId;
		const durable = this.options.durableSelection;
		if (!chatId || !durable) return;
		if (selection.agentId === durable.agentId) {
			this.resetToDurable();
			return;
		}
		this.selection = cloneSelection(selection);
		setLocalStorageItem(
			chatExecutionDraftStorageKey(chatId),
			JSON.stringify(this.selection),
		);
	}

	patchSelection(patch: Partial<ConversationExecutionSelection>): void {
		if (!this.selection || !this.isHandoffPending) return;
		this.replaceSelection({ ...this.selection, ...patch });
	}

	resetToDurable(): ConversationExecutionSelection | null {
		const chatId = this.options.activeChatId;
		if (chatId) removeLocalStorageItem(chatExecutionDraftStorageKey(chatId));
		const durable = this.options.durableSelection;
		this.selection = durable ? cloneSelection(durable) : null;
		return this.selection;
	}

	acceptDurable(selection: ConversationExecutionSelection): void {
		const chatId = this.options.activeChatId;
		if (chatId) removeLocalStorageItem(chatExecutionDraftStorageKey(chatId));
		this.selection = cloneSelection(selection);
	}

	handoffRequest(expectedAgentOwnershipEpoch: string): AgentHandoffRequest | null {
		if (!this.isHandoffPending || !this.selection) return null;
		if (!expectedAgentOwnershipEpoch.trim()) {
			throw new Error('The selected chat has no ownership epoch for an agent handoff');
		}
		return {
			target: cloneSelection(this.selection),
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

function parseStoredSelection(raw: string | null): ConversationExecutionSelection | null {
	if (!raw) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	const agentId = nonEmptyString(value.agentId);
	const model = nonEmptyString(value.model);
	const apiProviderId = nullableString(value.apiProviderId);
	const modelEndpointId = nullableString(value.modelEndpointId);
	const modelProtocol = nullableProtocol(value.modelProtocol);
	const agentSettings = parseAgentSettingsEnvelope(value.agentSettings);
	if (
		!agentId
		|| !model
		|| apiProviderId === undefined
		|| modelEndpointId === undefined
		|| modelProtocol === undefined
		|| !agentSettings
		|| agentSettings.ownerId !== agentId
	) return null;
	if (modelEndpointId !== null && apiProviderId === null) return null;
	return {
		agentId,
		model,
		apiProviderId,
		modelEndpointId,
		modelProtocol,
		permissionMode: normalizePermissionMode(value.permissionMode),
		thinkingMode: normalizeThinkingMode(value.thinkingMode),
		agentSettings,
	};
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
	return value === null || typeof value === 'string' ? value : undefined;
}

function nullableProtocol(value: unknown): ApiProtocol | null | undefined {
	return value === null || value === 'anthropic-messages' || value === 'openai-compatible'
		? value
		: undefined;
}
