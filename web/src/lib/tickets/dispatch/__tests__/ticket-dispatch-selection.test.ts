import { describe, expect, it } from 'vitest';
import { ModelCatalogStore, type AgentMetadata } from '$lib/agents/model-catalog-store.svelte';
import { DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID } from '$shared/agents';
import type { RecentAgentSetting, RemoteExecutionDefaults } from '$shared/settings';
import {
	resolveTicketDispatchSelection,
	ticketDispatchAgentIds,
	type TicketDispatchSelectionInput,
} from '../ticket-dispatch-selection.js';

function metadata(id: string, defaultModel: string): AgentMetadata {
	return {
		id,
		label: id,
		supportsCompact: false,
		supportsFork: false,
		supportsForkAtMessage: false,
		supportsForkWhileRunning: false,
		supportsUpdateProjectPath: true,
		supportsSteering: true,
		supportsImages: false,
		fileAttachmentMimeTypes: [],
		acceptsApiProviderEndpoints: false,
		supportedProtocols: [],
		authLoginSupported: false,
		supportedPermissionModes: ['default', 'acceptEdits'],
		supportedThinkingModes: ['none', 'high'],
		settings: [],
		defaultSettings: { ownerId: id, schemaVersion: 1, values: {} },
		defaultModel,
	};
}

function catalog(): ModelCatalogStore {
	const store = new ModelCatalogStore();
	store.agentMetadata = {
		claude: metadata('claude', 'opus'),
		codex: metadata('codex', 'gpt-5.5'),
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: metadata(DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID, 'direct'),
	};
	store.agentModels = {
		claude: [
			{ value: 'opus', label: 'Opus' },
			{ value: 'sonnet', label: 'Sonnet' },
		],
		codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: [{ value: 'direct', label: 'Direct' }],
	};
	return store;
}

const executionDefaults: RemoteExecutionDefaults = {
	global: { permissionMode: 'acceptEdits', thinkingMode: 'none', agentSettingsById: {} },
	byAgent: { codex: { thinkingMode: 'high' } },
};

function recent(agentId: string, model: string): RecentAgentSetting {
	return {
		agentId: agentId as RecentAgentSetting['agentId'],
		model,
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
	};
}

function input(overrides: Partial<TicketDispatchSelectionInput> = {}): TicketDispatchSelectionInput {
	const store = catalog();
	return {
		saved: undefined,
		recents: [],
		executionDefaults,
		catalogFor: (executorId) => store.forExecutor(executorId),
		...overrides,
	};
}

describe('resolveTicketDispatchSelection', () => {
	it('uses a saved selection with its saved effort', () => {
		const result = resolveTicketDispatchSelection(
			input({ saved: { agentId: 'claude', model: 'sonnet', thinkingMode: 'high' } }),
		);

		expect(result).toMatchObject({
			kind: 'ready',
			selection: {
				source: 'saved',
				executorId: 'local',
				agentId: 'claude',
				modelValue: 'sonnet',
				model: { model: 'sonnet', modelEndpointId: null },
				permissionMode: 'acceptEdits',
				thinkingMode: 'high',
				agentSettings: { ownerId: 'claude' },
			},
		});
	});

	it('reports a saved selection that is no longer available instead of swapping models', () => {
		for (const saved of [
			{ agentId: 'claude' as const, model: 'retired' },
			{ agentId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID, model: 'direct' },
			{ model: 'opus' },
		]) {
			expect(resolveTicketDispatchSelection(input({ saved }))).toEqual({
				kind: 'unavailable',
				executorId: 'local',
			});
		}
	});

	it('follows the most recent new-chat selection when nothing is saved', () => {
		const result = resolveTicketDispatchSelection(
			input({
				saved: { customPrompt: 'Do {{ticket}}' },
				recents: [recent(DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID, 'direct'), recent('codex', 'gpt-5.5')],
			}),
		);

		expect(result).toMatchObject({
			kind: 'ready',
			selection: {
				source: 'new-chat-default',
				agentId: 'codex',
				modelValue: 'gpt-5.5',
				thinkingMode: 'high',
			},
		});
	});

	it('falls back to the default agent and model without recents', () => {
		expect(resolveTicketDispatchSelection(input())).toMatchObject({
			kind: 'ready',
			selection: { source: 'new-chat-default', agentId: 'claude', modelValue: 'opus' },
		});
	});

	it('is unavailable when the executor catalog has no agents', () => {
		const empty = new ModelCatalogStore();
		const remoteId = '22222222-2222-4222-8222-222222222222';
		expect(
			resolveTicketDispatchSelection(
				input({ saved: { executorId: remoteId }, catalogFor: (id) => empty.forExecutor(id) }),
			),
		).toEqual({ kind: 'unavailable', executorId: remoteId });
	});
});

describe('ticketDispatchAgentIds', () => {
	it('excludes direct chats because they cannot use tools', () => {
		expect(ticketDispatchAgentIds(catalog())).toEqual(['claude', 'codex']);
	});
});
