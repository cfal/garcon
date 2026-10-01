import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateChatModel, updateExecutionSettings } from '$lib/api/chats.js';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ExecutionSettingsPatchResponse } from '$shared/chat-command-contracts';
import type { ResolvedModelSelection } from '$shared/start-selection';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { ChatListEntry, ChatListResponse } from '$shared/chat-list';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
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
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function chat(): ChatSessionRecord {
	return {
		id: 'chat-1',
		parentChat: null,
		projectPath: '/repo',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		model: 'opus',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { effort: 'low' } },
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

function createHarness() {
	const selectedChat = chat();
	const sessions = {
		byId: { [selectedChat.id]: selectedChat },
		selectedChatId: selectedChat.id as string | null,
		selectedChat,
		isDraft: vi.fn(() => false),
		patchDraftStartup: vi.fn(),
		quietRefreshChats: vi.fn(async (): Promise<void> => {}),
		patchChat: vi.fn((chatId: string, patch: Partial<ChatSessionRecord>) => {
			Object.assign(sessions.byId[chatId], patch);
		}),
	};
	const agentState = {
		executorId: 'local',
		agentId: 'claude' as const,
		model: 'opus',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: selectedChat.permissionMode,
		thinkingMode: selectedChat.thinkingMode,
		agentSettings: selectedChat.agentSettings,
		setAgentSettings: vi.fn((settings: AgentSettingsEnvelope) => {
			agentState.agentSettings = settings;
		}),
		setModelSelection: vi.fn((selection: ResolvedModelSelection) => {
			Object.assign(agentState, selection);
		}),
	};
	const modelCatalog = {
		getModelForSelection: vi.fn<
			ConversationSettingsControllerOptions['modelCatalog']['getModelForSelection']
		>(() => ({ value: 'opus', label: 'Opus' })),
		selectionFor: vi.fn((_agentId: string, model: string): ResolvedModelSelection => ({
			model,
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		})),
		selectionValueFor: vi.fn((_: unknown, model: string) => model),
		isLocalModel: vi.fn<ConversationSettingsControllerOptions['modelCatalog']['isLocalModel']>(
			() => false,
		),
		getPermissionModes: vi.fn(() => ['default', 'plan', 'bypassPermissions'] as const),
		getThinkingModes: vi.fn(() => ['none', 'high', 'medium'] as const),
	};
	const chatState = { appendLocalNoticeForChat: vi.fn() };
	const agentSwitch = { switchAgent: vi.fn(async () => undefined) };
	const options = {
		get sessions() {
			return sessions;
		},
		get agentState() {
			return agentState;
		},
		get modelCatalog() {
			return modelCatalog;
		},
		get chatState() {
			return chatState;
		},
		get agentSwitch() {
			return agentSwitch;
		},
	} satisfies ConversationSettingsControllerOptions;
	return {
		options,
		controller: new ConversationSettingsController(options),
		modelCatalog,
		chatState,
		sessions,
		agentState,
	};
}

describe('ConversationSettingsController', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(updateChatModel).mockImplementation(async (request) => ({
			success: true,
			...request,
		}));
		vi.mocked(updateExecutionSettings).mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			agentSettings: chat().agentSettings,
		});
	});

	for (const setting of ['model', 'permission', 'thinking', 'agentSettings'] as const) {
		it.each([
			[false, false],
			[true, false],
			[false, true],
			[true, true],
		])(
			`reconciles rapid ${setting} changes against confirmed values (first=%s, second=%s)`,
			async (firstAccepted, secondAccepted) => {
				type Response = Awaited<ReturnType<typeof updateChatModel>> &
					ExecutionSettingsPatchResponse;
				const first = deferred<Response>();
				const second = deferred<Response>();
				vi.mocked(updateChatModel)
					.mockReturnValueOnce(first.promise)
					.mockReturnValueOnce(second.promise);
				vi.mocked(updateExecutionSettings)
					.mockReturnValueOnce(first.promise)
					.mockReturnValueOnce(second.promise);
				const { controller, sessions, agentState } = createHarness();
				const original = { ...sessions.selectedChat };
				const choices = [
					{
						model: 'sonnet',
						permissionMode: 'plan',
						thinkingMode: 'high',
						agentSettings: { ...original.agentSettings, values: { effort: 'high' } },
					},
					{
						model: 'haiku',
						permissionMode: 'bypassPermissions',
						thinkingMode: 'medium',
						agentSettings: { ...original.agentSettings, values: { effort: 'low' } },
					},
				] as const;
				for (const choice of choices) {
					if (setting === 'model') controller.handleModelChange(choice.model);
					if (setting === 'permission')
						controller.handlePermissionModeChange(choice.permissionMode);
					if (setting === 'thinking') controller.handleThinkingModeChange(choice.thinkingMode);
					if (setting === 'agentSettings')
						controller.handleAgentSettingChange(effort, choice.agentSettings.values.effort);
				}
				const api = setting === 'model' ? updateChatModel : updateExecutionSettings;
				expect(api).toHaveBeenCalledTimes(1);
				if (firstAccepted) first.resolve({ success: true, chatId: original.id, ...choices[0] });
				else first.reject(new Error('Synthetic first rejection'));
				await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
				if (secondAccepted) second.resolve({ success: true, chatId: original.id, ...choices[1] });
				else second.reject(new Error('Synthetic second rejection'));
				expect(await controller.settlePending(original.id)).toBe(secondAccepted);
				const expected = secondAccepted ? choices[1] : firstAccepted ? choices[0] : original;
				const field =
					setting === 'permission'
						? 'permissionMode'
						: setting === 'thinking'
							? 'thinkingMode'
							: setting;
				expect(sessions.selectedChat[field]).toEqual(expected[field]);
				expect(agentState[field]).toEqual(expected[field]);
				expect(controller.hasPending(original.id)).toBe(false);
				expect(sessions.quietRefreshChats).toHaveBeenCalledOnce();
			},
		);
	}

	it('reconciles a committed model whose reply was lost without replaying the write', async () => {
		const { controller, sessions, agentState } = createHarness();
		vi.mocked(updateChatModel).mockRejectedValueOnce(new TypeError('Synthetic lost reply'));
		sessions.quietRefreshChats.mockImplementation(async () => {
			sessions.selectedChat.model = 'sonnet';
		});
		controller.handleModelChange('sonnet');
		expect(await controller.settlePending('chat-1')).toBe(false);
		expect(sessions.selectedChat.model).toBe('sonnet');
		expect(agentState.model).toBe('sonnet');
		expect(updateChatModel).toHaveBeenCalledOnce();
	});

	it('keeps the confirmed baseline when reconciliation also fails', async () => {
		const { controller, sessions, agentState } = createHarness();
		vi.mocked(updateChatModel).mockRejectedValue(new TypeError('Synthetic offline'));
		sessions.quietRefreshChats.mockRejectedValueOnce(new TypeError('Synthetic refresh failure'));
		controller.handleModelChange('sonnet');
		controller.handleModelChange('haiku');
		expect(await controller.settlePending('chat-1')).toBe(false);
		expect(sessions.selectedChat.model).toBe('opus');
		expect(agentState.model).toBe('opus');
		expect(controller.hasPending('chat-1')).toBe(false);
	});

	it('reconciles a newer choice made while the previous authoritative refresh is pending', async () => {
		const { controller, sessions, agentState } = createHarness();
		const refresh = deferred<void>();
		sessions.quietRefreshChats.mockImplementationOnce(async () => {
			await refresh.promise;
			sessions.selectedChat.model = 'sonnet';
		});
		controller.handleModelChange('sonnet');
		await vi.waitFor(() => expect(sessions.quietRefreshChats).toHaveBeenCalledOnce());
		vi.mocked(updateChatModel).mockRejectedValueOnce(new Error('Synthetic latest rejection'));
		controller.handleModelChange('haiku');
		refresh.resolve();
		expect(await controller.settlePending('chat-1')).toBe(false);
		expect(sessions.selectedChat.model).toBe('sonnet');
		expect(agentState.model).toBe('sonnet');
		expect(controller.hasPending('chat-1')).toBe(false);
	});

	it('keeps confirmed values independent across overlapping setting groups', async () => {
		const { controller, sessions, agentState } = createHarness();
		const model = deferred<Awaited<ReturnType<typeof updateChatModel>>>();
		vi.mocked(updateChatModel).mockReturnValueOnce(model.promise);
		vi.mocked(updateExecutionSettings).mockRejectedValueOnce(
			new Error('Synthetic permission rejection'),
		);
		controller.handleModelChange('sonnet');
		controller.handlePermissionModeChange('plan');
		model.resolve({ success: true, chatId: 'chat-1', model: 'sonnet' });
		expect(await controller.settlePending('chat-1')).toBe(false);
		expect(sessions.selectedChat).toMatchObject({ model: 'sonnet', permissionMode: 'default' });
		expect(agentState).toMatchObject({ model: 'sonnet', permissionMode: 'default' });
		expect(controller.hasPending('chat-1')).toBe(false);
	});

	it('lets the server validate repair of an unavailable local-model selection', () => {
		const { controller, sessions, modelCatalog, chatState } = createHarness();
		sessions.selectedChat.model = 'old-local';
		sessions.selectedChat.modelEndpointId = 'unassigned_endpoint';
		modelCatalog.getModelForSelection.mockReturnValue(null);
		modelCatalog.isLocalModel.mockImplementation((_, model) => model === 'replacement');
		modelCatalog.selectionFor.mockReturnValue({
			model: 'replacement',
			apiProviderId: 'assigned',
			modelEndpointId: 'assigned_endpoint',
			modelProtocol: 'anthropic-messages',
		});

		controller.handleModelChange('replacement');

		expect(updateChatModel).toHaveBeenCalledWith({
			chatId: 'chat-1',
			expectedAgentOwnershipEpoch: 'epoch-1',
			model: 'replacement',
			apiProviderId: 'assigned',
			modelEndpointId: 'assigned_endpoint',
			modelProtocol: 'anthropic-messages',
		});
		expect(chatState.appendLocalNoticeForChat).not.toHaveBeenCalled();
	});

	it('refreshes committed settings after an older chat-list request completes', async () => {
		const entry: ChatListEntry = {
			...chat(),
			orderGroup: 'normal',
			model: 'opus',
			activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
			preview: { lastMessage: '' },
			isActive: false,
			agentOwnershipEpoch: 'epoch-1',
		};
		const stale = deferred<ChatListResponse>();
		const latest: ChatListResponse = {
			sessions: [{ ...entry, permissionMode: 'bypassPermissions' }],
			total: 1,
			lastSelectedChatId: entry.id,
		};
		const fetchChats = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(latest);
		const sessions = new ChatSessionsStore({ listChats: fetchChats });
		sessions.upsertFromServer([entry]);
		sessions.selectedChatId = entry.id;
		const before = sessions.quietRefreshChats();
		const { options } = createHarness();
		const controller = new ConversationSettingsController({ ...options, sessions });
		controller.handlePermissionModeChange('bypassPermissions');
		await vi.waitFor(() => expect(updateExecutionSettings).toHaveBeenCalledOnce());
		await Promise.resolve();
		stale.resolve({ sessions: [entry], total: 1, lastSelectedChatId: entry.id });
		await before;
		await controller.settlePending(entry.id);
		expect(fetchChats).toHaveBeenCalledTimes(2);
		expect(sessions.selectedChat?.permissionMode).toBe('bypassPermissions');
	});

	it('still blocks a known cloud-to-local switch before updating the chat', () => {
		const { controller, modelCatalog, chatState } = createHarness();
		modelCatalog.isLocalModel.mockImplementation((_, model) => model === 'local-model');

		controller.handleModelChange('local-model');

		expect(updateChatModel).not.toHaveBeenCalled();
		expect(chatState.appendLocalNoticeForChat).toHaveBeenCalledWith(
			'chat-1',
			'error',
			expect.any(String),
		);
	});

	it('serializes settings requests and ignores a superseded response', async () => {
		const first = deferred<ExecutionSettingsPatchResponse>();
		const second = deferred<ExecutionSettingsPatchResponse>();
		vi.mocked(updateExecutionSettings)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { controller, sessions, agentState } = createHarness();

		controller.handleAgentSettingChange(effort, 'high');
		controller.handleAgentSettingChange(effort, 'low');
		expect(updateExecutionSettings).toHaveBeenCalledTimes(1);
		const latest = { ownerId: 'claude', schemaVersion: 1, values: { effort: 'low' } };
		second.resolve({ success: true, chatId: 'chat-1', agentSettings: latest });
		await second.promise;
		await Promise.resolve();
		first.resolve({
			success: true,
			chatId: 'chat-1',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { effort: 'high' } },
		});
		await first.promise;
		await controller.settlePending('chat-1');

		expect(agentState.agentSettings).toEqual(latest);
		expect(sessions.patchChat).toHaveBeenLastCalledWith('chat-1', { agentSettings: latest });
	});

	it.each(['model', 'permission', 'thinking'] as const)(
		'keeps a late %s failure out of another chat composer',
		async (setting) => {
			const pending = deferred<never>();
			vi.mocked(updateChatModel).mockReturnValueOnce(pending.promise);
			vi.mocked(updateExecutionSettings).mockReturnValueOnce(pending.promise);
			const { controller, sessions, agentState, chatState } = createHarness();
			if (setting === 'model') controller.handleModelChange('sonnet');
			if (setting === 'permission') controller.handlePermissionModeChange('plan');
			if (setting === 'thinking') controller.handleThinkingModeChange('high');
			sessions.selectedChatId = 'chat-2';
			agentState.model = 'other-model';
			agentState.permissionMode = 'bypassPermissions';
			agentState.thinkingMode = 'medium';
			pending.reject(new Error('Synthetic rejection'));
			await pending.promise.catch(() => undefined);
			await controller.settlePending('chat-1');
			expect(agentState).toMatchObject({
				model: 'other-model',
				permissionMode: 'bypassPermissions',
				thinkingMode: 'medium',
			});
			expect(chatState.appendLocalNoticeForChat).toHaveBeenCalledWith(
				'chat-1',
				'error',
				expect.any(String),
			);
		},
	);

	it.each(['model', 'permission', 'thinking'] as const)(
		'ignores a superseded %s failure before sending the newer request',
		async (setting) => {
			const pending = deferred<never>();
			vi.mocked(updateChatModel).mockReturnValueOnce(pending.promise);
			vi.mocked(updateExecutionSettings).mockReturnValueOnce(pending.promise).mockResolvedValue({
				success: true,
				chatId: 'chat-1',
				agentSettings: chat().agentSettings,
			});
			const { controller, sessions, agentState, chatState } = createHarness();
			if (setting === 'model') {
				controller.handleModelChange('sonnet');
				controller.handleModelChange('new-model');
			}
			if (setting === 'permission') {
				controller.handlePermissionModeChange('plan');
				controller.handlePermissionModeChange('bypassPermissions');
			}
			if (setting === 'thinking') {
				controller.handleThinkingModeChange('high');
				controller.handleThinkingModeChange('medium');
			}
			await Promise.resolve();
			await Promise.resolve();
			const latest = { ...sessions.selectedChat };
			const model = agentState.model;
			pending.reject(new Error('Synthetic stale rejection'));
			await pending.promise.catch(() => undefined);
			await controller.settlePending('chat-1');
			expect(sessions.selectedChat).toEqual(latest);
			expect(agentState.model).toBe(model);
			expect(chatState.appendLocalNoticeForChat).not.toHaveBeenCalled();
		},
	);

	it('does not roll back settings across a durable ownership change', async () => {
		const pending = deferred<never>();
		vi.mocked(updateChatModel).mockReturnValueOnce(pending.promise);
		const { controller, sessions, agentState } = createHarness();
		controller.handleModelChange('sonnet');
		sessions.selectedChat.agentOwnershipEpoch = 'epoch-2';
		sessions.selectedChat.model = 'destination-model';
		agentState.model = 'destination-model';
		pending.reject(new Error('Synthetic stale rejection'));
		await pending.promise.catch(() => undefined);
		await controller.settlePending('chat-1');
		expect(agentState.model).toBe('destination-model');
		expect(sessions.selectedChat.model).toBe('destination-model');
	});

	it('keeps submission pending until a successful write and its authoritative refresh settle', async () => {
		const request = deferred<Awaited<ReturnType<typeof updateChatModel>>>();
		const refresh = deferred<void>();
		vi.mocked(updateChatModel).mockReturnValueOnce(request.promise);
		const { controller, sessions } = createHarness();
		sessions.quietRefreshChats.mockReturnValueOnce(refresh.promise);
		controller.handleModelChange('sonnet');
		const settled = vi.fn();
		const waiting = controller.settlePending('chat-1').then(settled);
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();
		request.resolve({ success: true, chatId: 'chat-1', model: 'sonnet' });
		await vi.waitFor(() => expect(sessions.quietRefreshChats).toHaveBeenCalledOnce());
		expect(settled).not.toHaveBeenCalled();
		refresh.resolve();
		await waiting;
		expect(settled).toHaveBeenCalledWith(true);
	});
});
