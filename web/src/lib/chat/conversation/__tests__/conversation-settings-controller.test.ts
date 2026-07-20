import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateExecutionSettings } from '$lib/api/chats.js';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
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
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function chat(): ChatSessionRecord {
	return {
		id: 'chat-1',
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
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { effort: 'low' } },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'running',
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
		selectedChatId: selectedChat.id as string | null,
		selectedChat,
		isDraft: vi.fn(() => false),
		patchDraftStartup: vi.fn(),
		patchChat: vi.fn(),
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
	const options = {
		get sessions() { return sessions; },
		get agentState() { return agentState; },
		get modelCatalog() { return modelCatalog; },
		get chatState() { return chatState; },
		get agentSwitch() { return agentSwitch; },
	} satisfies ConversationSettingsControllerOptions;
	return { controller: new ConversationSettingsController(options), sessions, agentState };
}

describe('ConversationSettingsController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('ignores an older agent-settings response after a newer mutation settles', async () => {
		const first = deferred<{ agentSettings: AgentSettingsEnvelope }>();
		const second = deferred<{ agentSettings: AgentSettingsEnvelope }>();
		vi.mocked(updateExecutionSettings)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { controller, sessions, agentState } = createHarness();

		controller.handleAgentSettingChange(effort, 'high');
		controller.handleAgentSettingChange(effort, 'low');
		const latest = { ownerId: 'claude', schemaVersion: 1, values: { effort: 'low' } };
		second.resolve({ agentSettings: latest });
		await second.promise;
		await Promise.resolve();
		first.resolve({
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { effort: 'high' } },
		});
		await first.promise;
		await Promise.resolve();

		expect(agentState.agentSettings).toEqual(latest);
		expect(sessions.patchChat).toHaveBeenLastCalledWith('chat-1', { agentSettings: latest });
	});
});
