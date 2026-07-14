import { beforeEach, describe, expect, it, vi } from 'vitest';

import { updateChatAgentModel } from '$lib/api/chats.js';
import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import {
	ConversationAgentSwitchService,
	type ConversationAgentSwitchDeps,
} from '../conversation-agent-switch-service.js';

vi.mock('$lib/api/chats.js', () => ({
	updateChatAgentModel: vi.fn(),
}));

const mockUpdateChatAgentModel = vi.mocked(updateChatAgentModel);

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
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'running',
		tags: [],
		...overrides,
	};
}

function nextSelection(): ModelSelectorChange {
	return {
		agentId: 'codex',
		modelValue: 'gpt-5.5',
		model: 'gpt-5.5',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
	};
}

function createDeps(chat = createChat()) {
	const patchChat = vi.fn();
	const appendLocalNotice = vi.fn();
	const reloadTranscript = vi.fn().mockResolvedValue(undefined);
	const agentState: ConversationAgentSwitchDeps['agentState'] = {
		agentId: 'claude',
		model: 'sonnet',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		setAgentId(agentId) {
			this.agentId = agentId;
		},
		setModelSelection(selection) {
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
			patchChat,
		},
		chatState: { appendLocalNotice },
		agentState,
		modelCatalog: {
			selectionFor: vi.fn((agentId, model) => ({
				model,
				apiProviderId: agentId === 'codex' ? 'openai' : null,
				modelEndpointId: null,
				modelProtocol: agentId === 'codex' ? ('openai-compatible' as const) : null,
			})),
			selectionValueFor: vi.fn((_agentId, model) => model),
			getAgentLabel: vi.fn((agentId) => (agentId === 'codex' ? 'Codex' : 'Claude')),
		},
		reloadTranscript,
	} satisfies ConversationAgentSwitchDeps;
	return { deps, agentState, appendLocalNotice, patchChat, reloadTranscript };
}

describe('ConversationAgentSwitchService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects draft switches without mutating local selection', async () => {
		const { deps, agentState, appendLocalNotice, patchChat } = createDeps(
			createChat({ status: 'draft' }),
		);

		await new ConversationAgentSwitchService(deps).switchAgent('chat-1', nextSelection());

		expect(mockUpdateChatAgentModel).not.toHaveBeenCalled();
		expect(agentState.agentId).toBe('claude');
		expect(patchChat).not.toHaveBeenCalled();
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('before switching agents'),
		);
	});

	it('applies the optimistic selection and server-normalized modes', async () => {
		const { deps, agentState, patchChat, reloadTranscript } = createDeps();
		mockUpdateChatAgentModel.mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			agentId: 'codex',
			model: 'gpt-5.5',
			apiProviderId: 'openai',
			modelEndpointId: null,
			modelProtocol: 'openai-compatible',
			permissionMode: 'bypassPermissions',
			thinkingMode: 'high',
			claudeThinkingMode: 'auto',
			ampAgentMode: 'smart',
		});

		await new ConversationAgentSwitchService(deps).switchAgent('chat-1', nextSelection());

		expect(mockUpdateChatAgentModel).toHaveBeenCalledWith({
			chatId: 'chat-1',
			agentId: 'codex',
			model: 'gpt-5.5',
			apiProviderId: 'openai',
			modelEndpointId: null,
			modelProtocol: 'openai-compatible',
		});
		expect(agentState).toMatchObject({
			agentId: 'codex',
			model: 'gpt-5.5',
			permissionMode: 'bypassPermissions',
			thinkingMode: 'high',
		});
		expect(patchChat).toHaveBeenLastCalledWith(
			'chat-1',
			expect.objectContaining({ permissionMode: 'bypassPermissions', thinkingMode: 'high' }),
		);
		expect(reloadTranscript).toHaveBeenCalledWith('chat-1');
	});

	it('rolls back the complete selection when the server rejects', async () => {
		const { deps, agentState, patchChat, appendLocalNotice, reloadTranscript } = createDeps();
		mockUpdateChatAgentModel.mockRejectedValueOnce(new Error('switch failed'));

		await new ConversationAgentSwitchService(deps).switchAgent('chat-1', nextSelection());

		expect(agentState).toMatchObject({
			agentId: 'claude',
			model: 'sonnet',
			apiProviderId: null,
			permissionMode: 'default',
			thinkingMode: 'none',
		});
		expect(patchChat).toHaveBeenLastCalledWith(
			'chat-1',
			expect.objectContaining({ agentId: 'claude', model: 'sonnet' }),
		);
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('switch failed'),
		);
		expect(reloadTranscript).not.toHaveBeenCalled();
	});

	it('keeps a successful switch when transcript reload fails', async () => {
		const { deps, agentState, appendLocalNotice, reloadTranscript } = createDeps();
		reloadTranscript.mockRejectedValueOnce(new Error('history unavailable'));
		mockUpdateChatAgentModel.mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			agentId: 'codex',
			model: 'gpt-5.5',
			apiProviderId: 'openai',
			modelEndpointId: null,
			modelProtocol: 'openai-compatible',
			permissionMode: 'default',
			thinkingMode: 'none',
			claudeThinkingMode: 'auto',
			ampAgentMode: 'smart',
		});

		await new ConversationAgentSwitchService(deps).switchAgent('chat-1', nextSelection());

		expect(agentState.agentId).toBe('codex');
		expect(appendLocalNotice).not.toHaveBeenCalled();
	});
});
