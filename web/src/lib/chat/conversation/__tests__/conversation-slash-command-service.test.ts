import { beforeEach, describe, expect, it, vi } from 'vitest';

import { compactChat, forkChat, forkRunChat } from '$lib/api/chats.js';
import { scheduleChatPrompt } from '$lib/api/scheduled-prompts.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import {
	ConversationSlashCommandService,
	type ConversationSlashCommandDeps,
} from '$lib/chat/conversation/conversation-slash-command-service.js';

vi.mock('$lib/api/chats.js', () => ({
	compactChat: vi.fn(),
	forkChat: vi.fn(),
	forkRunChat: vi.fn(),
}));

vi.mock('$lib/api/scheduled-prompts.js', () => ({
	scheduleChatPrompt: vi.fn(),
}));

const mockCompactChat = vi.mocked(compactChat);
const mockForkChat = vi.mocked(forkChat);
const mockForkRunChat = vi.mocked(forkRunChat);
const mockScheduleChatPrompt = vi.mocked(scheduleChatPrompt);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

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

function createServerEntry(id: string) {
	return {
		id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default' as const,
		thinkingMode: 'none' as const,
		claudeThinkingMode: 'auto' as const,
		ampAgentMode: 'smart' as const,
		title: 'Forked chat',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		orderGroup: 'normal' as const,
		tags: [],
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isUnread: false,
	};
}

function createDeps(chat = createChat()) {
	const composerState: ConversationSlashCommandDeps['composerState'] = {
		inputText: 'original command',
		images: [],
		clearAfterSubmit: vi.fn(() => {
			composerState.inputText = '';
			composerState.images = [];
		}),
		saveDraft: vi.fn(),
	};
	const appendLocalNotice = vi.fn();
	const deps = {
		sessions: {
			selectedChatId: chat.id,
			byId: { [chat.id]: chat },
			renameChat: vi.fn().mockResolvedValue(true),
			upsertServerChat: vi.fn(),
			setSelectedChatId: vi.fn(),
			setChatProcessing: vi.fn(),
		},
		chatState: {
			activeChatId: chat.id,
			isUserScrolledUp: true,
			appendLocalNotice,
		},
		composerState,
		agentState: { model: 'sonnet' },
		lifecycle: {
			beginTurn: vi.fn(),
			setCurrentChatId: vi.fn(),
		},
		modelCatalog: {
			selectionFor: vi.fn((_agentId, model) => ({
				model,
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			})),
		},
		navigation: { navigateToChat: vi.fn() },
		scrollToBottom: vi.fn(),
	} satisfies ConversationSlashCommandDeps;
	return { deps, composerState, appendLocalNotice };
}

describe('ConversationSlashCommandService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('restores rename text and attachments when rename fails', async () => {
		const { deps, composerState } = createDeps();
		const image = new File(['image'], 'test.png', { type: 'image/png' });
		composerState.images = [image];
		deps.sessions.renameChat.mockResolvedValueOnce(false);

		await new ConversationSlashCommandService(deps).submitRenameCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'Renamed chat',
			[],
			true,
		);

		expect(composerState.inputText).toBe('original command');
		expect(composerState.images).toEqual([image]);
		expect(composerState.saveDraft).toHaveBeenCalledWith('chat-1');
	});

	it('deduplicates an in-flight schedule and restores a failed command', async () => {
		const { deps, composerState, appendLocalNotice } = createDeps();
		const pending = deferred<Awaited<ReturnType<typeof scheduleChatPrompt>>>();
		mockScheduleChatPrompt.mockReturnValueOnce(pending.promise);
		const service = new ConversationSlashCommandService(deps);
		const command = {
			kind: 'valid',
			duration: '1m',
			delayMinutes: 1,
			prompt: 'Continue',
		} as const;

		const first = service.submitScheduleInCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			command,
			[],
			true,
		);
		const second = service.submitScheduleInCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			command,
			[],
			true,
		);

		expect(mockScheduleChatPrompt).toHaveBeenCalledTimes(1);
		pending.reject(new Error('storage unavailable'));
		await Promise.all([first, second]);
		expect(composerState.inputText).toBe('original command');
		expect(composerState.saveDraft).toHaveBeenCalledWith('chat-1');
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('storage unavailable'),
		);
	});

	it('reports a successful schedule only in its still-active chat', async () => {
		const { deps, appendLocalNotice } = createDeps();
		mockScheduleChatPrompt.mockResolvedValueOnce({
			success: true,
			scheduledPrompt: {
				id: 'prompt-1',
				schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
				target: { type: 'existing-chat', chatId: 'chat-1', busyBehavior: 'skip' },
				prompt: 'Continue',
				createdAt: '2029-01-01T00:00:00.000Z',
				updatedAt: '2029-01-01T00:00:00.000Z',
			},
			snapshot: { revision: 1, prompts: [], runLog: [] },
		});

		await new ConversationSlashCommandService(deps).submitScheduleInCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			{ kind: 'valid', duration: '1m', delayMinutes: 1, prompt: 'Continue' },
			[],
			true,
		);

		expect(appendLocalNotice).toHaveBeenCalledWith(
			'info',
			expect.stringContaining('Prompt scheduled for'),
		);
		expect(deps.chatState.isUserScrolledUp).toBe(false);
		expect(deps.scrollToBottom).toHaveBeenCalled();
	});

	it('restores compact text when the API fails', async () => {
		const { deps, composerState, appendLocalNotice } = createDeps();
		mockCompactChat.mockRejectedValueOnce(new Error('compact unavailable'));

		await new ConversationSlashCommandService(deps).submitCompactCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'keep decisions',
			true,
		);

		expect(composerState.inputText).toBe('original command');
		expect(composerState.saveDraft).toHaveBeenCalledWith('chat-1');
		expect(appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('compact unavailable'),
		);
	});

	it('forks and runs while selecting the projected server chat before beginning the turn', async () => {
		const { deps } = createDeps();
		const forked = createServerEntry('chat-2');
		mockForkRunChat.mockResolvedValueOnce({
			success: true,
			commandType: 'fork-run',
			clientRequestId: 'request-1',
			chatId: 'chat-2',
			status: 'accepted',
			acceptedAt: '2026-07-14T00:00:00.000Z',
			chat: forked,
		});

		await new ConversationSlashCommandService(deps).submitForkCommand(
			'chat-1',
			deps.sessions.byId['chat-1'],
			'continue here',
			[],
			true,
		);

		expect(mockForkRunChat).toHaveBeenCalledWith(
			expect.objectContaining({ sourceChatId: 'chat-1', command: 'continue here' }),
		);
		expect(deps.sessions.upsertServerChat).toHaveBeenCalledWith(forked);
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('chat-2');
		expect(deps.navigation.navigateToChat).toHaveBeenCalledWith('chat-2');
		expect(deps.lifecycle.beginTurn).toHaveBeenCalledWith('chat-2');
		expect(deps.sessions.setChatProcessing).toHaveBeenCalledWith('chat-2', true);
	});

	it('forks without a message and preserves the requested sequence', async () => {
		const { deps } = createDeps();
		const forked = createServerEntry('chat-2');
		mockForkChat.mockResolvedValueOnce({ success: true, chat: forked });

		await new ConversationSlashCommandService(deps).forkChat('chat-1', 9);

		expect(mockForkChat).toHaveBeenCalledWith({
			sourceChatId: 'chat-1',
			chatId: expect.stringMatching(/^\d+$/),
			upToSeq: 9,
		});
		expect(deps.sessions.upsertServerChat).toHaveBeenCalledWith(forked);
		expect(deps.lifecycle.setCurrentChatId).toHaveBeenCalledWith('chat-2');
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('chat-2');
	});
});
