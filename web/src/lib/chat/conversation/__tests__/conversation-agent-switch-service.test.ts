import { describe, expect, it, vi } from 'vitest';

import type { ChatSessionRecord } from '$lib/types/chat-session';
import {
	ConversationAgentSwitchService,
	type ConversationAgentSwitchDeps,
} from '$lib/chat/conversation/conversation-agent-switch-service.js';
import {
	ConversationExecutionDraftState,
	type ConversationExecutionSelection,
} from '../conversation-execution-draft-state.svelte.js';
import type { ExecutorHandoffModel, ExecutorHandoffDestination } from '../executor-handoff-project.svelte.js';

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
	let handoffPending = false;
	const replaceSelection = vi.fn(() => {
		handoffPending = true;
	});
	const resetToDurable = vi.fn(() => {
		handoffPending = false;
		return claudeSelection();
	});
	const agentState = {
		executorId: 'local',
		projectPath: chat.projectPath,
		agentId: 'claude',
		model: 'sonnet',
		apiProviderId: null as string | null,
		modelEndpointId: null as string | null,
		modelProtocol: null as 'openai-compatible' | 'anthropic-messages' | null,
		permissionMode: 'default' as const,
		thinkingMode: 'none' as const,
		agentSettings: claudeSelection().agentSettings,
		setAgentId(agentId: string) {
			this.agentId = agentId;
		},
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
		executionDraft: {
			replaceSelection,
			replaceDestination: replaceSelection,
			resetToDurable,
			get isHandoffPending() {
				return handoffPending;
			},
		},
		modelCatalogForExecutor(): ConversationAgentSwitchDeps['modelCatalog'] {
			return this.modelCatalog;
		},
		chooseDestination: vi.fn(
			async (
				_chatId: string,
				_executorId: string,
				projectPath: string,
				selection: ExecutorHandoffModel,
			): Promise<ExecutorHandoffDestination | null> => ({ projectPath, selection }),
		),
		getExecutionDefaults: vi.fn((agentId: string) => ({
			permissionMode: 'bypassPermissions' as const,
			thinkingMode: 'high' as const,
			agentSettings: { ownerId: agentId, schemaVersion: 1, values: { effort: 'high' } },
		})),
	} satisfies ConversationAgentSwitchDeps;
	return { deps, agentState, patchChat, patchDraftStartup, replaceSelection, resetToDurable };
}

describe('ConversationAgentSwitchService', () => {
	it.each(['local', '11111111-1111-4111-8111-111111111111'])(
		'restores the durable selection when the dialog returns its current owner (%s)',
		async (executorId) => {
			const { deps, agentState } = createDeps(createChat({ executorId }));
			agentState.executorId = executorId;
			const durable = { ...claudeSelection(), executorId, projectPath: '/workspace/project' };
			const executionDraft = new ConversationExecutionDraftState({
				activeChatId: 'chat-1',
				durableSelection: durable,
			});
			executionDraft.activate('chat-1');
			const service = new ConversationAgentSwitchService({ ...deps, executionDraft });
			try {
				await service.switchAgent('chat-1', {
					executorId: '22222222-2222-4222-8222-222222222222',
					agentId: 'codex',
					modelValue: 'gpt-5.5',
				});
				expect(executionDraft.isHandoffPending).toBe(true);
				deps.chooseDestination.mockResolvedValueOnce({
					projectPath: '/workspace/not-applied',
					selection: { ...claudeSelection(), model: 'opus' },
				});
				await service.switchAgent('chat-1', { executorId, agentId: 'codex', modelValue: 'gpt-5.5' });
				expect(deps.chooseDestination).toHaveBeenCalledTimes(2);
				expect(executionDraft.handoffRequest('epoch-1')).toBeNull();
				expect(executionDraft.selection).toEqual(durable);
				expect(agentState).toMatchObject(durable);
			} finally {
				executionDraft.resetToDurable();
			}
		},
	);
	it.each(['local', '11111111-1111-4111-8111-111111111111'])(
		'keeps the confirmed folder when returning a pending remote selection to the chat executor (%s)',
		async (executorId) => {
			const { deps, agentState } = createDeps(createChat({ executorId }));
			agentState.executorId = executorId;
			const durable = { ...claudeSelection(), executorId, projectPath: '/workspace/project' };
			const executionDraft = new ConversationExecutionDraftState({
				activeChatId: 'chat-1',
				durableSelection: durable,
			});
			executionDraft.activate('chat-1');
			const service = new ConversationAgentSwitchService({ ...deps, executionDraft });
			deps.chooseDestination.mockResolvedValueOnce({
				projectPath: '/worker/chosen',
				selection: {
					...claudeSelection(),
					agentId: 'codex',
					model: 'gpt-5.5',
				},
			});
			try {
				await service.switchAgent('chat-1', {
					executorId: '22222222-2222-4222-8222-222222222222',
					agentId: 'codex',
					modelValue: 'gpt-5.5',
				});
				expect(agentState.projectPath).toBe('/worker/chosen');
				deps.chooseDestination.mockResolvedValueOnce({
					projectPath: '/workspace/chosen',
					selection: {
						...claudeSelection(),
						agentId: 'codex',
						model: 'gpt-5.5',
					},
				});
				await service.switchAgent('chat-1', { executorId, agentId: 'codex', modelValue: 'gpt-5.5' });
				expect(deps.chooseDestination).toHaveBeenCalledTimes(2);
				expect(agentState).toMatchObject({
					executorId,
					agentId: 'codex',
					projectPath: '/workspace/chosen',
				});
				expect(deps.chooseDestination).toHaveBeenLastCalledWith(
					'chat-1', executorId, '/workspace/project', expect.objectContaining({ agentId: 'codex' }),
				);
				const request = executionDraft.handoffRequest('epoch-1');
				expect(request?.target).toMatchObject({
					executorId,
					agentId: 'codex',
					projectPath: '/workspace/chosen',
				});
				executionDraft.patchSelection({ model: 'gpt-5.4' });
				expect(executionDraft.handoffRequest('epoch-1')?.target).toMatchObject({
					executorId,
					agentId: 'codex',
					model: 'gpt-5.4',
					projectPath: '/workspace/chosen',
				});
			} finally {
				executionDraft.resetToDurable();
			}
		},
	);
	it('stages a complete destination only after confirmation and preserves ownership on cancel', async () => {
		const { deps, agentState, replaceSelection, patchChat } = createDeps();
		const service = new ConversationAgentSwitchService(deps);
		const held = Promise.withResolvers<ExecutorHandoffDestination | null>();
		deps.chooseDestination.mockReturnValueOnce(held.promise);
		const next = {
			executorId: '22222222-2222-4222-8222-222222222222',
			agentId: 'claude',
			modelValue: 'sonnet',
		};
		const pending = service.switchAgent('chat-1', next);
		expect(agentState.executorId).toBe('local');
		expect(replaceSelection).not.toHaveBeenCalled();
		held.resolve(null);
		await pending;
		expect(agentState.executorId).toBe('local');
		deps.chooseDestination.mockResolvedValueOnce({
			projectPath: '/worker',
			selection: { ...claudeSelection(), agentId: 'codex', model: 'gpt-5.5' },
		});
		await service.switchAgent('chat-1', next);
		expect(replaceSelection).toHaveBeenCalledWith(
			expect.objectContaining({
				executorId: next.executorId,
				projectPath: '/worker',
				agentId: 'codex',
				model: 'gpt-5.5',
			}),
		);
		expect(patchChat).not.toHaveBeenCalled();
	});
	it('preserves a cold-loaded endpoint identity when proposing another executor', async () => {
		const { deps, agentState } = createDeps();
		agentState.modelEndpointId = 'saved-endpoint';
		agentState.apiProviderId = 'saved-provider';
		agentState.modelProtocol = 'openai-compatible';
		deps.chooseDestination.mockResolvedValueOnce(null);
		await new ConversationAgentSwitchService(deps).switchAgent('chat-1', {
			executorId: '22222222-2222-4222-8222-222222222222',
			agentId: 'claude',
			modelValue: 'sonnet',
		});
		expect(deps.chooseDestination).toHaveBeenCalledWith(
			'chat-1',
			'22222222-2222-4222-8222-222222222222',
			'/workspace/project',
			{
				agentId: 'claude',
				model: 'sonnet',
				modelEndpointId: 'saved-endpoint',
				apiProviderId: 'saved-provider',
				modelProtocol: 'openai-compatible',
			},
		);
	});

	it('keeps the confirmed directory when changing agent on a staged destination', async () => {
		const { deps, replaceSelection } = createDeps();
		const service = new ConversationAgentSwitchService(deps);
		const executorId = '22222222-2222-4222-8222-222222222222';
		deps.chooseDestination.mockResolvedValueOnce({
			projectPath: '/worker/project',
			selection: {
				...claudeSelection(),
				agentId: 'claude',
				model: 'sonnet',
			},
		});
		await service.switchAgent('chat-1', { executorId, agentId: 'claude', modelValue: 'sonnet' });
		await service.switchAgent('chat-1', { executorId, agentId: 'codex', modelValue: 'gpt-5.5' });
		expect(deps.chooseDestination).toHaveBeenCalledOnce();
		expect(replaceSelection).toHaveBeenLastCalledWith(
			expect.objectContaining({
				executorId,
				projectPath: '/worker/project',
				agentId: 'codex',
				model: 'gpt-5.5',
			}),
		);
	});

	it('uses the current durable directory rather than the activation-time directory', async () => {
		const { deps, replaceSelection } = createDeps();
		deps.sessions.selectedChat = { ...deps.sessions.selectedChat, projectPath: '/workspace/new' };
		await new ConversationAgentSwitchService(deps).switchAgent('chat-1', {
			executorId: 'local',
			agentId: 'codex',
			modelValue: 'gpt-5.5',
		});
		expect(replaceSelection).toHaveBeenCalledWith(
			expect.objectContaining({ projectPath: '/workspace/new' }),
		);
		expect(deps.chooseDestination).not.toHaveBeenCalled();
	});

	it('stores a running-chat switch only in the execution draft', () => {
		const { deps, agentState, patchChat, replaceSelection } = createDeps();

		new ConversationAgentSwitchService(deps).switchAgent('chat-1', {
			agentId: 'codex',
			modelValue: 'gpt-5.5',
		});

		expect(replaceSelection).toHaveBeenCalledWith({
			executorId: 'local',
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
