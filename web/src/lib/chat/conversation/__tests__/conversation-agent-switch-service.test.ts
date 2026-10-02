import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import {
	ConversationAgentSwitchService,
	type ConversationAgentSwitchDeps,
} from '../conversation-agent-switch-service.js';
import type { ExecutorHandoffDestination } from '../executor-handoff-project.svelte.js';

const remote = '22222222-2222-4222-8222-222222222222';
const model = {
	agentId: 'claude',
	model: 'sonnet',
	apiProviderId: null,
	modelEndpointId: null,
	modelProtocol: null,
};

function harness() {
	const chat: ChatSessionRecord = {
		...model,
		id: 'chat-1',
		projectPath: '/local',
		orderGroup: 'normal',
		title: 'Synthetic chat',
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
		parentChat: null,
	};
	const agentState: ConversationAgentSwitchDeps['agentState'] = {
		...model,
		executorId: 'local',
		projectPath: '/local',
		permissionMode: 'default',
		thinkingMode: 'none',
		setAgentId: vi.fn((id) => {
			agentState.agentId = id;
		}),
		setAgentSettings: vi.fn(),
		setModelSelection: vi.fn((selection) => {
			Object.assign(agentState, selection);
		}),
	};
	const catalog: ReturnType<ConversationAgentSwitchDeps['modelCatalogForExecutor']> = {
		selectionFor: (_agentId, value) => ({ ...model, model: value }),
		selectionValueFor: (_agentId, value) => value,
	};
	const deps = {
		sessions: {
			selectedChat: chat,
			isDraft: () => chat.status === 'draft',
			patchDraftStartup: vi.fn(),
			patchChat: vi.fn(),
		},
		agentState,
		modelCatalogForExecutor: () => catalog,
		chooseDestination: vi.fn<ConversationAgentSwitchDeps['chooseDestination']>(async () => ({
			projectPath: '/remote',
			selection: model,
		})),
		commitHandoff: vi.fn<ConversationAgentSwitchDeps['commitHandoff']>(async () => undefined),
		projectUnavailable: vi.fn<ConversationAgentSwitchDeps['projectUnavailable']>(() => false),
		getExecutionDefaults: (agentId: string) => ({
			permissionMode: 'default' as const,
			thinkingMode: 'none' as const,
			agentSettings: { ownerId: agentId, schemaVersion: 1, values: {} },
		}),
	} satisfies ConversationAgentSwitchDeps;
	return { deps, service: new ConversationAgentSwitchService(deps), chat, agentState };
}

describe('ConversationAgentSwitchService', () => {
	it('commits the confirmed executor and folder immediately without optimistic retargeting', async () => {
		const { deps, service, agentState } = harness();
		const confirmation = Promise.withResolvers<ExecutorHandoffDestination | null>();
		const commit = Promise.withResolvers<void>();
		deps.chooseDestination.mockReturnValueOnce(confirmation.promise);
		deps.commitHandoff.mockReturnValueOnce(commit.promise);
		const pending = service.switchAgent('chat-1', {
			executorId: remote,
			agentId: 'claude',
			modelValue: 'sonnet',
		});
		expect(deps.commitHandoff).not.toHaveBeenCalled();
		confirmation.resolve({ projectPath: '/remote', selection: model });
		await vi.waitFor(() =>
			expect(deps.commitHandoff).toHaveBeenCalledWith('chat-1', {
				expectedAgentOwnershipEpoch: 'epoch-1',
				target: {
					...model,
					executorId: remote,
					projectPath: '/remote',
					permissionMode: 'default',
					thinkingMode: 'none',
					agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				},
			}),
		);
		expect(agentState.executorId).toBe('local');
		expect(deps.sessions.patchChat).not.toHaveBeenCalled();
		commit.resolve();
		await pending;
	});

	it.each(['cancel', 'chat-switch', 'owner-change', 'superseded'])(
		'does not commit a cancelled or obsolete confirmation: %s',
		async (reason) => {
			const { deps, service, chat } = harness();
			const confirmation = Promise.withResolvers<ExecutorHandoffDestination | null>();
			deps.chooseDestination.mockReturnValueOnce(confirmation.promise);
			const pending = service.switchAgent('chat-1', {
				executorId: remote,
				agentId: 'claude',
				modelValue: 'sonnet',
			});
			if (reason === 'chat-switch') deps.sessions.selectedChat = { ...chat, id: 'chat-2' };
			if (reason === 'owner-change')
				deps.sessions.selectedChat = { ...chat, agentOwnershipEpoch: 'epoch-2' };
			if (reason === 'superseded')
				await service.switchAgent('chat-1', {
					executorId: 'local',
					agentId: 'claude',
					modelValue: 'sonnet',
				});
			confirmation.resolve(
				reason === 'cancel' ? null : { projectPath: '/remote', selection: model },
			);
			await pending;
			expect(deps.commitHandoff).not.toHaveBeenCalled();
		},
	);

	it('preserves the original selection when commit fails', async () => {
		const { deps, service, agentState } = harness();
		deps.commitHandoff.mockRejectedValueOnce(new Error('Synthetic rejection'));
		await expect(
			service.switchAgent('chat-1', {
				executorId: remote,
				agentId: 'claude',
				modelValue: 'sonnet',
			}),
		).rejects.toThrow('Synthetic rejection');
		expect(agentState).toMatchObject({ ...model, executorId: 'local', projectPath: '/local' });
		expect(deps.sessions.patchChat).not.toHaveBeenCalled();
	});

	it('preserves the current endpoint identity when the model catalog is incomplete', async () => {
		const { deps, service, agentState } = harness();
		Object.assign(agentState, {
			apiProviderId: 'provider-1',
			modelEndpointId: 'endpoint-1',
			modelProtocol: 'anthropic-messages',
		});
		await service.switchAgent('chat-1', {
			executorId: remote,
			agentId: 'claude',
			modelValue: 'sonnet',
		});
		expect(deps.chooseDestination).toHaveBeenCalledWith('chat-1', remote, '/local', {
			...model,
			apiProviderId: 'provider-1',
			modelEndpointId: 'endpoint-1',
			modelProtocol: 'anthropic-messages',
		});
	});

	it('lets the server preserve the durable folder for same-executor agent changes', async () => {
		const { deps, service, chat } = harness();
		chat.projectPath = '/updated';
		await service.switchAgent('chat-1', { agentId: 'codex', modelValue: 'target-model' });
		expect(deps.chooseDestination).not.toHaveBeenCalled();
		expect(deps.commitHandoff).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({
				target: expect.objectContaining({
					executorId: 'local',
					agentId: 'codex',
					model: 'target-model',
				}),
			}),
		);
		expect(deps.commitHandoff.mock.calls[0][1].target).not.toHaveProperty('projectPath');
	});

	it('chooses a folder for same-executor agent changes away from an unavailable project', async () => {
		const { deps, service } = harness();
		deps.projectUnavailable.mockReturnValue(true);
		deps.chooseDestination.mockResolvedValueOnce({
			projectPath: '/recovered',
			selection: { ...model, agentId: 'codex', model: 'target-model' },
		});
		await service.switchAgent('chat-1', { agentId: 'codex', modelValue: 'target-model' });
		expect(deps.projectUnavailable).toHaveBeenCalledWith('chat-1');
		expect(deps.chooseDestination).toHaveBeenCalledWith(
			'chat-1',
			'local',
			'/local',
			expect.objectContaining({ model: 'target-model' }),
		);
		expect(deps.commitHandoff).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({
				target: expect.objectContaining({
					executorId: 'local',
					agentId: 'codex',
					projectPath: '/recovered',
				}),
			}),
		);
	});

	it('keeps the source owner when same-executor folder recovery is cancelled', async () => {
		const { deps, service } = harness();
		deps.projectUnavailable.mockReturnValue(true);
		deps.chooseDestination.mockResolvedValueOnce(null);
		await service.switchAgent('chat-1', { agentId: 'codex', modelValue: 'target-model' });
		expect(deps.chooseDestination).toHaveBeenCalledOnce();
		expect(deps.commitHandoff).not.toHaveBeenCalled();
	});

	it('updates unstarted draft configuration without a server handoff', async () => {
		const { deps, service, chat, agentState } = harness();
		chat.status = 'draft';
		await service.switchAgent('chat-1', {
			executorId: remote,
			agentId: 'claude',
			modelValue: 'sonnet',
		});
		expect(deps.commitHandoff).not.toHaveBeenCalled();
		expect(agentState.executorId).toBe(remote);
		expect(deps.sessions.patchDraftStartup).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({ executorId: remote, projectPath: '/remote' }),
		);
	});
});
