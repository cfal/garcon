import { describe, expect, it, vi } from 'vitest';

import type { ChatSessionRecord } from '$lib/types/chat-session';
import {
	ConversationAgentSwitchService,
	type ConversationAgentSwitchDeps,
} from '$lib/chat/conversation/conversation-agent-switch-service.js';
import type { ConversationExecutionSelection } from '../conversation-execution-draft-state.svelte.js';

function createChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
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
		status: 'running',
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
		...overrides,
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
		getExecutionDefaults: vi.fn((agentId: string) => ({
			permissionMode: 'bypassPermissions' as const,
			thinkingMode: 'high' as const,
			agentSettings: { ownerId: agentId, schemaVersion: 1, values: { effort: 'high' } },
		})),
	} satisfies ConversationAgentSwitchDeps;
	return { deps, agentState, patchChat, patchDraftStartup, replaceSelection, resetToDurable };
}

describe('ConversationAgentSwitchService', () => {
	it('stores a running-chat switch only in the execution draft', () => {
		const { deps, agentState, patchChat, replaceSelection } = createDeps();

		new ConversationAgentSwitchService(deps).switchAgent('chat-1', {
			agentId: 'codex',
			modelValue: 'gpt-5.5',
		});

		expect(replaceSelection).toHaveBeenCalledWith({
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
