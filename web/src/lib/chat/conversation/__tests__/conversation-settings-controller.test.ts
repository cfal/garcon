import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateChatModel, updateExecutionSettings } from '$lib/api/chats.js';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ExecutionSettingsPatchResponse } from '$shared/chat-command-contracts';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import {
	ConversationSettingsController,
	type ConversationSettingsControllerOptions,
} from '../conversation-settings-controller.svelte.js';

vi.mock('$lib/api/chats.js', () => ({
	updateChatModel: vi.fn(),
	updateExecutionSettings: vi.fn(),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

type Effort = 'low' | 'high';

function chat(initialEffort: Effort = 'low'): ChatSessionRecord {
	return {
		id: 'chat-1',
		parentChat: null,
		projectPath: '/repo',
		effectiveProjectKey: '/repo',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		model: 'opus',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: {
			ownerId: 'claude',
			schemaVersion: 1,
			values: { effort: initialEffort },
		},
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
	};
}

const effort = {
	key: 'effort',
	type: 'enum',
	label: 'Effort',
	options: [
		{ value: 'low', label: 'Low' },
		{ value: 'high', label: 'High' },
	],
} satisfies AgentSettingDescriptor;

function settingsResponse(effort: Effort): ExecutionSettingsPatchResponse {
	return {
		success: true,
		chatId: 'chat-1',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { effort } },
	};
}

function createHarness(initialEffort: Effort = 'low') {
	const selectedChat = chat(initialEffort);
	const byId: Record<string, ChatSessionRecord> = { [selectedChat.id]: selectedChat };
	const sessions = {
		selectedChatId: selectedChat.id as string | null,
		get byId() {
			return byId;
		},
		get selectedChat() {
			return sessions.selectedChatId ? (byId[sessions.selectedChatId] ?? null) : null;
		},
		hasChat: vi.fn((chatId: string) => Boolean(byId[chatId])),
		isDraft: vi.fn(() => false),
		patchDraftStartup: vi.fn(),
		patchChat: vi.fn((chatId: string, patch: Partial<ChatSessionRecord>) => {
			const current = byId[chatId];
			if (current) byId[chatId] = { ...current, ...patch };
		}),
	};
	const agentState = {
		agentId: 'claude' as const,
		model: 'opus',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default' as const,
		thinkingMode: 'none' as const,
		agentSettings: selectedChat.agentSettings,
		setAgentSettings: vi.fn((settings: AgentSettingsEnvelope) => {
			agentState.agentSettings = settings;
		}),
		setModelSelection: vi.fn(),
	};
	const modelCatalog = {
		selectionFor: vi.fn(() => ({
			model: 'opus',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		})),
		selectionValueFor: vi.fn((_: unknown, model: string) => model),
		isLocalModel: vi.fn(() => false),
		getPermissionModes: vi.fn(() => ['default'] as const),
		getThinkingModes: vi.fn(() => ['none'] as const),
	};
	const chatState = { appendLocalNotice: vi.fn() };
	const agentSwitch = { switchAgent: vi.fn(async () => undefined) };
	const executionDraft = {
		isHandoffPending: false,
		patchSelection: vi.fn(),
	};
	const options = {
		get sessions() { return sessions; },
		get agentState() { return agentState; },
		get modelCatalog() { return modelCatalog; },
		get chatState() { return chatState; },
		get agentSwitch() { return agentSwitch; },
		get executionDraft() { return executionDraft; },
	} satisfies ConversationSettingsControllerOptions;
	return {
		controller: new ConversationSettingsController(options),
		sessions,
		agentState,
		executionDraft,
		chatState,
		deleteChat: (chatId: string) => {
			delete byId[chatId];
		},
	};
}

describe('ConversationSettingsController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		{
			name: 'On succeeds and Off succeeds',
			initial: 'low' as const,
			first: 'high' as const,
			firstOutcome: 'success' as const,
			second: 'low' as const,
			secondOutcome: 'success' as const,
			expected: 'low' as const,
			notices: 0,
		},
		{
			name: 'On fails and Off succeeds',
			initial: 'low' as const,
			first: 'high' as const,
			firstOutcome: 'failure' as const,
			second: 'low' as const,
			secondOutcome: 'success' as const,
			expected: 'low' as const,
			notices: 1,
		},
		{
			name: 'On succeeds and Off fails',
			initial: 'low' as const,
			first: 'high' as const,
			firstOutcome: 'success' as const,
			second: 'low' as const,
			secondOutcome: 'failure' as const,
			expected: 'high' as const,
			notices: 1,
		},
		{
			name: 'Off succeeds and On fails',
			initial: 'high' as const,
			first: 'low' as const,
			firstOutcome: 'success' as const,
			second: 'high' as const,
			secondOutcome: 'failure' as const,
			expected: 'low' as const,
			notices: 1,
		},
	])('serializes and projects $name', async ({
		initial,
		first: firstValue,
		firstOutcome,
		second: secondValue,
		secondOutcome,
		expected,
		notices,
	}) => {
		const first = deferred<ExecutionSettingsPatchResponse>();
		const second = deferred<ExecutionSettingsPatchResponse>();
		vi.mocked(updateExecutionSettings)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { controller, sessions, agentState, chatState } = createHarness(initial);

		controller.handleAgentSettingChange(effort, firstValue);
		controller.handleAgentSettingChange(effort, secondValue);
		const waiting = controller.awaitPendingAgentSettings('chat-1');
		expect(updateExecutionSettings).toHaveBeenCalledTimes(1);
		if (firstOutcome === 'success') first.resolve(settingsResponse(firstValue));
		else first.reject(new Error(`Failed to apply ${firstValue}`));
		await vi.waitFor(() => expect(updateExecutionSettings).toHaveBeenCalledTimes(2));
		expect(vi.mocked(updateExecutionSettings).mock.calls[1][0]).toMatchObject({
			agentSettingsPatch: { effort: secondValue },
		});
		if (secondOutcome === 'success') second.resolve(settingsResponse(secondValue));
		else second.reject(new Error(`Failed to apply ${secondValue}`));
		if (secondOutcome === 'success') await expect(waiting).resolves.toBeUndefined();
		else await expect(waiting).rejects.toThrow(`Failed to apply ${secondValue}`);

		expect(agentState.agentSettings.values.effort).toBe(expected);
		expect(sessions.byId['chat-1']?.agentSettings.values.effort).toBe(expected);
		expect(chatState.appendLocalNotice).toHaveBeenCalledTimes(notices);
	});

	it('waits through both FIFO entries when the captured mutation is second', async () => {
		const first = deferred<ExecutionSettingsPatchResponse>();
		const second = deferred<ExecutionSettingsPatchResponse>();
		vi.mocked(updateExecutionSettings)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { controller } = createHarness();

		controller.handleAgentSettingChange(effort, 'high');
		controller.handleAgentSettingChange(effort, 'low');
		const waiting = controller.awaitPendingAgentSettings('chat-1');
		let settled = false;
		void waiting.then(() => {
			settled = true;
		});

		first.resolve(settingsResponse('high'));
		await vi.waitFor(() => expect(updateExecutionSettings).toHaveBeenCalledTimes(2));
		await Promise.resolve();
		expect(settled).toBe(false);

		second.resolve(settingsResponse('low'));
		await expect(waiting).resolves.toBeUndefined();
	});

	it('does not adopt a mutation added after a waiter captures the current tail', async () => {
		const first = deferred<ExecutionSettingsPatchResponse>();
		const second = deferred<ExecutionSettingsPatchResponse>();
		vi.mocked(updateExecutionSettings)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { controller } = createHarness();

		controller.handleAgentSettingChange(effort, 'high');
		const waiting = controller.awaitPendingAgentSettings('chat-1');
		controller.handleAgentSettingChange(effort, 'low');
		first.resolve(settingsResponse('high'));

		await expect(waiting).resolves.toBeUndefined();
		expect(updateExecutionSettings).toHaveBeenCalledTimes(2);
		second.resolve(settingsResponse('low'));
		await controller.awaitPendingAgentSettings('chat-1');
	});

	it('settles a captured completion only after failure rollback is projected', async () => {
		const update = deferred<ExecutionSettingsPatchResponse>();
		vi.mocked(updateExecutionSettings).mockReturnValueOnce(update.promise);
		const { controller, agentState, chatState } = createHarness();

		controller.handleAgentSettingChange(effort, 'high');
		const waiting = controller.awaitPendingAgentSettings('chat-1');
		const failure = new Error('settings rejected');
		update.reject(failure);

		await expect(waiting).rejects.toBe(failure);
		expect(agentState.agentSettings.values.effort).toBe('low');
		expect(chatState.appendLocalNotice).toHaveBeenCalledTimes(1);
	});

	it('does not update a switched or deleted chat when a mutation settles', async () => {
		const update = deferred<ExecutionSettingsPatchResponse>();
		vi.mocked(updateExecutionSettings).mockReturnValueOnce(update.promise);
		const { controller, sessions, agentState, deleteChat } = createHarness();

		controller.handleAgentSettingChange(effort, 'high');
		const waiting = controller.awaitPendingAgentSettings('chat-1');
		sessions.patchChat.mockClear();
		agentState.setAgentSettings.mockClear();
		deleteChat('chat-1');
		sessions.selectedChatId = null;
		update.resolve({
			success: true,
			chatId: 'chat-1',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { effort: 'high' } },
		});

		await expect(waiting).resolves.toBeUndefined();
		expect(sessions.patchChat).not.toHaveBeenCalled();
		expect(agentState.setAgentSettings).not.toHaveBeenCalled();
	});

	it('keeps target execution edits local while a handoff is pending', () => {
		const { controller, sessions, executionDraft } = createHarness();
		executionDraft.isHandoffPending = true;

		controller.handleModelChange('gpt-5.5');
		controller.handlePermissionModeChange('bypassPermissions');
		controller.handleThinkingModeChange('high');

		expect(executionDraft.patchSelection).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'opus' }),
		);
		expect(executionDraft.patchSelection).toHaveBeenCalledWith({
			permissionMode: 'bypassPermissions',
		});
		expect(executionDraft.patchSelection).toHaveBeenCalledWith({ thinkingMode: 'high' });
		expect(updateChatModel).not.toHaveBeenCalled();
		expect(updateExecutionSettings).not.toHaveBeenCalled();
		expect(sessions.patchChat).not.toHaveBeenCalled();
	});
});
