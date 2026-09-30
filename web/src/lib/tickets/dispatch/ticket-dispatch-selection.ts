// Resolves the agent, model, and execution modes that a ticket dispatch starts
// a chat with. A saved selection wins; without one, dispatch follows the same
// recent-selection defaults as the new-chat form.

import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import { nonDirectAgentIds } from '$lib/agents/direct-agents.js';
import { firstSelectableExecutorRecent } from '$lib/chat/new-chat/new-chat-executor-preferences.js';
import type { SessionAgentId } from '$lib/types/app.js';
import { normalizeAgentSettings } from '$shared/agent-settings';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import { DEFAULT_AGENT_ID } from '$shared/agents';
import type { PermissionMode, ThinkingMode } from '$shared/chat-modes';
import {
	executionDefaultsForAgent,
	normalizeSupportedPermissionMode,
	normalizeSupportedThinkingMode,
} from '$shared/execution-defaults';
import { effectiveExecutorId } from '$shared/executors';
import type {
	RecentAgentSetting,
	RemoteExecutionDefaults,
	TicketDispatchUiSettings,
} from '$shared/settings';
import type { ResolvedModelSelection } from '$shared/start-selection';

export type TicketDispatchCatalog = Pick<
	ModelCatalogStore,
	| 'getSelectableAgents'
	| 'getModels'
	| 'getDefaultModel'
	| 'getModelForSelection'
	| 'selectionFor'
	| 'selectionValueFor'
	| 'getPermissionModes'
	| 'getThinkingModes'
	| 'getDefaultAgentSettings'
>;

export interface TicketDispatchSelectionInput {
	readonly saved: TicketDispatchUiSettings | undefined;
	readonly recents: readonly RecentAgentSetting[];
	readonly executionDefaults: RemoteExecutionDefaults | null;
	readonly catalogFor: (executorId: string) => TicketDispatchCatalog;
}

export interface TicketDispatchSelection {
	readonly source: 'saved' | 'new-chat-default';
	readonly executorId: string;
	readonly agentId: SessionAgentId;
	/** Catalog value that identifies the model in the model selector. */
	readonly modelValue: string;
	readonly model: ResolvedModelSelection;
	readonly permissionMode: PermissionMode;
	readonly thinkingMode: ThinkingMode;
	readonly agentSettings: AgentSettingsEnvelope;
}

export type TicketDispatchSelectionResult =
	| { readonly kind: 'ready'; readonly selection: TicketDispatchSelection }
	| { readonly kind: 'unavailable'; readonly executorId: string };

/** Direct chats have no tools, so they cannot work on a ticket. */
export function ticketDispatchAgentIds(catalog: TicketDispatchCatalog): readonly SessionAgentId[] {
	return nonDirectAgentIds(catalog.getSelectableAgents());
}

export function hasSavedTicketDispatchSelection(saved: TicketDispatchUiSettings | undefined): boolean {
	return Boolean(saved?.agentId || saved?.model || saved?.executorId != null);
}

export function resolveTicketDispatchSelection(
	input: TicketDispatchSelectionInput,
): TicketDispatchSelectionResult {
	const saved = input.saved;
	const executorId = effectiveExecutorId(saved?.executorId);
	const catalog = input.catalogFor(executorId);
	const agentIds = ticketDispatchAgentIds(catalog);

	if (hasSavedTicketDispatchSelection(saved)) {
		// A saved choice that vanished surfaces as unavailable instead of silently
		// dispatching with a different model.
		const agentId = saved?.agentId as SessionAgentId | undefined;
		const model =
			agentId && agentIds.includes(agentId) && saved?.model
				? catalog.getModelForSelection(agentId, saved.model, saved.modelEndpointId)
				: null;
		if (!agentId || !model) return { kind: 'unavailable', executorId };
		return {
			kind: 'ready',
			selection: buildSelection(input, catalog, {
				source: 'saved',
				executorId,
				agentId,
				modelValue: model.value,
				thinkingMode: saved?.thinkingMode,
			}),
		};
	}

	const recent = firstSelectableExecutorRecent(input.recents, executorId, agentIds, catalog);
	if (recent) {
		const agentId = recent.agentId as SessionAgentId;
		const model = catalog.getModelForSelection(agentId, recent.model, recent.modelEndpointId);
		if (model)
			return {
				kind: 'ready',
				selection: buildSelection(input, catalog, {
					source: 'new-chat-default',
					executorId,
					agentId,
					modelValue: model.value,
				}),
			};
	}

	const agentId = agentIds.includes(DEFAULT_AGENT_ID) ? DEFAULT_AGENT_ID : agentIds[0];
	if (!agentId) return { kind: 'unavailable', executorId };
	const model =
		catalog.getModelForSelection(agentId, catalog.getDefaultModel(agentId)) ??
		catalog.getModels(agentId)[0];
	if (!model) return { kind: 'unavailable', executorId };
	return {
		kind: 'ready',
		selection: buildSelection(input, catalog, {
			source: 'new-chat-default',
			executorId,
			agentId,
			modelValue: model.value,
		}),
	};
}

function buildSelection(
	input: TicketDispatchSelectionInput,
	catalog: TicketDispatchCatalog,
	choice: {
		source: TicketDispatchSelection['source'];
		executorId: string;
		agentId: SessionAgentId;
		modelValue: string;
		thinkingMode?: ThinkingMode;
	},
): TicketDispatchSelection {
	const { agentId } = choice;
	const modes = executionDefaultsForAgent(input.executionDefaults, agentId);
	const defaultSettings = catalog.getDefaultAgentSettings(agentId);
	return {
		source: choice.source,
		executorId: choice.executorId,
		agentId,
		modelValue: choice.modelValue,
		model: catalog.selectionFor(agentId, choice.modelValue),
		permissionMode: normalizeSupportedPermissionMode(
			modes.permissionMode,
			catalog.getPermissionModes(agentId),
		),
		thinkingMode: normalizeSupportedThinkingMode(
			choice.thinkingMode ?? modes.thinkingMode,
			catalog.getThinkingModes(agentId),
		),
		agentSettings: normalizeAgentSettings(
			agentId,
			modes.agentSettingsById[agentId] ?? defaultSettings,
			defaultSettings,
		),
	};
}
