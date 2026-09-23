import { describe, expect, it, vi } from 'vitest';

import type { ChatSessionRecord } from '$lib/types/chat-session';
import {
	ConversationAgentSwitchService,
	type ConversationAgentSwitchDeps,
} from '$lib/chat/conversation/conversation-agent-switch-service.js';
import type { ConversationExecutionSelection } from '../conversation-execution-draft-state.svelte.js';
import type { NodeHandoffModel, NodeHandoffDestination } from '../node-handoff-project.svelte.js';

function createChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		model: 'sonnet',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'running',
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
		...overrides,
		parentChat: overrides.parentChat ?? null,
	};
}

function claudeSelection(): ConversationExecutionSelection {
	return {
		agentId: 'claude',
		model: 'sonnet',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
	};
}

function createDeps(chat = createChat()) {
	const patchChat = vi.fn();
	const patchDraftStartup = vi.fn();
	const replaceSelection = vi.fn();
	const resetToDurable = vi.fn(() => claudeSelection());
	const agentState = {
		nodeId: 'local',
		projectPath: chat.projectPath,
		agentId: 'claude',
		model: 'sonnet',
		apiProviderId: null as string | null,
		modelEndpointId: null as string | null,
		modelProtocol: null as 'openai-compatible' | 'anthropic-messages' | null,
		permissionMode: 'default' as const,
		thinkingMode: 'none' as const,
		agentSettings: claudeSelection().agentSettings,
		setAgentId(agentId: string) { this.agentId = agentId; },
		setAgentSettings(settings: ConversationExecutionSelection['agentSettings']) {
			this.agentSettings = settings;
		},
		setModelSelection(selection: {
			model: string;
			apiProviderId: string | null;
			modelEndpointId: string | null;
			modelProtocol: 'openai-compatible' | 'anthropic-messages' | null;
		}) {
			this.model = selection.model;
			this.apiProviderId = selection.apiProviderId;
			this.modelEndpointId = selection.modelEndpointId;
			this.modelProtocol = selection.modelProtocol;
		},
	};
	const deps = {
		sessions: {
			selectedChat: chat,
			isDraft: vi.fn(() => chat.status === 'draft'),
			patchDraftStartup,
			patchChat,
		},
		agentState,
		modelCatalog: {
			selectionFor: vi.fn((_agentId, model) => ({
				model,
				apiProviderId: 'openai',
				modelEndpointId: null,
				modelProtocol: 'openai-compatible' as const,
			})),
			selectionValueFor: vi.fn((_agentId, model) => model),
		},
		executionDraft: { replaceSelection, resetToDurable },
		modelCatalogForNode(): ConversationAgentSwitchDeps['modelCatalog'] { return this.modelCatalog; },
		chooseDestination: vi.fn(async (_chatId: string, _nodeId: string, projectPath: string, selection: NodeHandoffModel): Promise<NodeHandoffDestination | null> => ({ projectPath, selection })),
		getExecutionDefaults: vi.fn((agentId: string) => ({
			permissionMode: 'bypassPermissions' as const,
			thinkingMode: 'high' as const,
			agentSettings: { ownerId: agentId, schemaVersion: 1, values: { effort: 'high' } },
		})),
	} satisfies ConversationAgentSwitchDeps;
	return { deps, agentState, patchChat, patchDraftStartup, replaceSelection, resetToDurable };
}

describe('ConversationAgentSwitchService', () => {
	it('stages a complete destination only after confirmation and preserves ownership on cancel', async () => {
		const { deps, agentState, replaceSelection, patchChat } = createDeps();
		const service = new ConversationAgentSwitchService(deps);
		const held = Promise.withResolvers<NodeHandoffDestination | null>();
		deps.chooseDestination.mockReturnValueOnce(held.promise);
		const next = { nodeId: '22222222-2222-4222-8222-222222222222', agentId: 'claude', modelValue: 'sonnet' };
		const pending = service.switchAgent('chat-1', next);
		expect(agentState.nodeId).toBe('local');
		expect(replaceSelection).not.toHaveBeenCalled();
		held.resolve(null);
		await pending;
		expect(agentState.nodeId).toBe('local');
		deps.chooseDestination.mockResolvedValueOnce({ projectPath: '/worker', selection: { ...claudeSelection(), agentId: 'codex', model: 'gpt-5.5' } });
		await service.switchAgent('chat-1', next);
		expect(replaceSelection).toHaveBeenCalledWith(expect.objectContaining({ nodeId: next.nodeId, projectPath: '/worker', agentId: 'codex', model: 'gpt-5.5' }));
		expect(patchChat).not.toHaveBeenCalled();
	});
	it('preserves a cold-loaded endpoint identity when proposing another node', async () => {
		const { deps, agentState } = createDeps();
		agentState.modelEndpointId = 'saved-endpoint';
		agentState.apiProviderId = 'saved-provider';
		agentState.modelProtocol = 'openai-compatible';
		deps.chooseDestination.mockResolvedValueOnce(null);
		await new ConversationAgentSwitchService(deps).switchAgent('chat-1', {
			nodeId: '22222222-2222-4222-8222-222222222222', agentId: 'claude', modelValue: 'sonnet',
		});
		expect(deps.chooseDestination).toHaveBeenCalledWith('chat-1',
			'22222222-2222-4222-8222-222222222222', '/workspace/project', {
				agentId: 'claude', model: 'sonnet', modelEndpointId: 'saved-endpoint',
				apiProviderId: 'saved-provider', modelProtocol: 'openai-compatible',
			});
	});

	it('keeps the confirmed directory when changing agent on a staged destination', async () => {
		const { deps, replaceSelection } = createDeps();
		const service = new ConversationAgentSwitchService(deps);
		const nodeId = '22222222-2222-4222-8222-222222222222';
		deps.chooseDestination.mockResolvedValueOnce({ projectPath: '/worker/project', selection: {
			...claudeSelection(), agentId: 'claude', model: 'sonnet',
		} });
		await service.switchAgent('chat-1', { nodeId, agentId: 'claude', modelValue: 'sonnet' });
		await service.switchAgent('chat-1', { nodeId, agentId: 'codex', modelValue: 'gpt-5.5' });
		expect(deps.chooseDestination).toHaveBeenCalledOnce();
		expect(replaceSelection).toHaveBeenLastCalledWith(expect.objectContaining({
			nodeId, projectPath: '/worker/project', agentId: 'codex', model: 'gpt-5.5',
		}));
	});

	it('stores a running-chat switch only in the execution draft', () => {
		const { deps, agentState, patchChat, replaceSelection } = createDeps();

		new ConversationAgentSwitchService(deps).switchAgent('chat-1', {
			agentId: 'codex',
			modelValue: 'gpt-5.5',
		});

		expect(replaceSelection).toHaveBeenCalledWith({
			nodeId: 'local',
			projectPath: '/workspace/project',
			agentId: 'codex',
			model: 'gpt-5.5',
			apiProviderId: 'openai',
			modelEndpointId: null,
			modelProtocol: 'openai-compatible',
			permissionMode: 'bypassPermissions',
			thinkingMode: 'high',
			agentSettings: {
				ownerId: 'codex',
				schemaVersion: 1,
				values: { effort: 'high' },
			},
		});
		expect(agentState).toMatchObject({ agentId: 'codex', model: 'gpt-5.5' });
		expect(patchChat).not.toHaveBeenCalled();
	});

	it('updates draft startup configuration directly', () => {
		const { deps, patchDraftStartup, patchChat, replaceSelection } = createDeps(
			createChat({ status: 'draft', agentOwnershipEpoch: null }),
		);

		new ConversationAgentSwitchService(deps).switchAgent('chat-1', {
			agentId: 'codex',
			modelValue: 'gpt-5.5',
		});

		expect(patchDraftStartup).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({ agentId: 'codex', model: 'gpt-5.5' }),
		);
		expect(patchChat).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({ agentId: 'codex', model: 'gpt-5.5' }),
		);
		expect(replaceSelection).not.toHaveBeenCalled();
	});

	it('cancels a pending switch when the durable owner is selected', () => {
		const { deps, agentState, resetToDurable, replaceSelection } = createDeps();
		agentState.agentId = 'codex';

		new ConversationAgentSwitchService(deps).switchAgent('chat-1', {
			agentId: 'claude',
			modelValue: 'ignored',
		});

		expect(resetToDurable).toHaveBeenCalledOnce();
		expect(replaceSelection).not.toHaveBeenCalled();
		expect(agentState).toMatchObject({ agentId: 'claude', model: 'sonnet' });
	});
});
