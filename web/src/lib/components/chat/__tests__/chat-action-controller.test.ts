import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import * as m from '$lib/paraglide/messages.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatListEntry } from '$shared/chat-list';
import {
	ChatActionController,
	type ChatActionControllerDeps,
} from '../chat-action-controller.svelte';
import { ChatActionDialogsState } from '../chat-action-dialogs-state.svelte';

vi.mock('$lib/api/chats', () => ({
	deleteChat: vi.fn(),
	forkChat: vi.fn(),
	getChatDetails: vi.fn(),
	reorderChatsQuick: vi.fn(),
	setChatTags: vi.fn(),
	toggleArchive: vi.fn(),
	togglePinned: vi.fn(),
	updateChatProjectPath: vi.fn(),
}));

vi.mock('$lib/chat/sessions/client-chat-id.js', () => ({
	createClientChatId: () => 'fork-chat-id',
}));

function makeChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/repo',
		effectiveProjectKey: '/workspace/repo',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'draft',
		tags: [],
		...overrides,
	};
}

function makeServerChat(overrides: Partial<ChatListEntry> = {}): ChatListEntry {
	return {
		id: 'fork-chat-id',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		title: 'Fork',
		projectPath: '/workspace/repo',
		effectiveProjectKey: '/workspace/repo',
		orderGroup: 'normal',
		tags: [],
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isUnread: false,
		...overrides,
	};
}

function createHarness(
	options: {
		chats?: ChatSessionRecord[];
		selectedChatId?: string | null;
		onReloadChat?: (chatId: string) => Promise<void> | void;
	} = {},
) {
	const chats = options.chats ?? [makeChat()];
	const selectedChatId =
		options.selectedChatId === undefined ? (chats[0]?.id ?? null) : options.selectedChatId;
	const callbacks = {
		onQuietRefresh: vi.fn(async () => undefined),
		onSelectChat: vi.fn(),
		onNewChat: vi.fn(),
		onDeleteChat: vi.fn(async () => undefined),
		onRenameChat: vi.fn(async () => undefined),
		onProjectPathUpdated: vi.fn(),
		onUpsertServerChat: vi.fn(),
		notifyError: vi.fn(),
		requestComposerFocus: vi.fn(),
		requestSidebarRecenter: vi.fn(),
	};
	const deps = {
		get chats() {
			return chats;
		},
		get selectedChatId() {
			return selectedChatId;
		},
		...callbacks,
		onReloadChat: options.onReloadChat,
	} satisfies ChatActionControllerDeps;

	return { controller: new ChatActionController(deps), callbacks };
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(chatsApi.togglePinned).mockResolvedValue({ success: true, isPinned: true });
	vi.mocked(chatsApi.toggleArchive).mockResolvedValue({ success: true, isArchived: true });
	vi.mocked(chatsApi.setChatTags).mockResolvedValue({
		success: true,
		chatId: 'chat-1',
		tags: ['review'],
	});
});

describe('ChatActionController', () => {
	it('refreshes pin mutations and recenters only a newly pinned selected chat', async () => {
		const selected = createHarness({ chats: [makeChat()], selectedChatId: 'chat-1' });
		await selected.controller.togglePinned('chat-1');

		expect(chatsApi.togglePinned).toHaveBeenCalledWith('chat-1');
		expect(selected.callbacks.onQuietRefresh).toHaveBeenCalledOnce();
		expect(selected.callbacks.requestSidebarRecenter).toHaveBeenCalledOnce();

		const alreadyPinned = createHarness({
			chats: [makeChat({ isPinned: true })],
			selectedChatId: 'chat-1',
		});
		await alreadyPinned.controller.togglePinned('chat-1');

		expect(alreadyPinned.callbacks.requestSidebarRecenter).not.toHaveBeenCalled();
	});

	it('selects the next neighbor when archiving the selected chat', async () => {
		const chats = [
			makeChat({ id: 'first' }),
			makeChat({ id: 'selected' }),
			makeChat({ id: 'next' }),
		];
		const { controller, callbacks } = createHarness({ chats, selectedChatId: 'selected' });

		await controller.toggleArchive('selected');

		expect(chatsApi.toggleArchive).toHaveBeenCalledWith('selected');
		expect(callbacks.onQuietRefresh).toHaveBeenCalledOnce();
		expect(callbacks.onSelectChat).toHaveBeenCalledWith('next');
		expect(callbacks.onNewChat).not.toHaveBeenCalled();
	});

	it('creates a new chat when archiving the only selected chat', async () => {
		const { controller, callbacks } = createHarness();

		await controller.toggleArchive('chat-1');

		expect(callbacks.onNewChat).toHaveBeenCalledOnce();
		expect(callbacks.onSelectChat).not.toHaveBeenCalled();
	});

	it('recenters an archived selected chat after restoring it', async () => {
		const { controller, callbacks } = createHarness({
			chats: [makeChat({ isArchived: true })],
			selectedChatId: 'chat-1',
		});

		await controller.toggleArchive('chat-1');

		expect(callbacks.requestSidebarRecenter).toHaveBeenCalledOnce();
		expect(callbacks.onNewChat).not.toHaveBeenCalled();
	});

	it('reports mutation failures without applying selection side effects', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(chatsApi.toggleArchive).mockRejectedValueOnce(new Error('offline'));
		const { controller, callbacks } = createHarness();

		await controller.toggleArchive('chat-1');

		expect(callbacks.notifyError).toHaveBeenCalledWith(m.notifications_archive_chat_failed());
		expect(callbacks.onSelectChat).not.toHaveBeenCalled();
		expect(callbacks.onNewChat).not.toHaveBeenCalled();
	});

	it('clears confirmation state and delegates delete and trimmed rename actions', async () => {
		const { controller, callbacks } = createHarness();
		const dialogs = new ChatActionDialogsState();
		const chat = makeChat();
		dialogs.requestDelete(chat, 'New chat');

		await controller.confirmDelete(dialogs);

		expect(dialogs.chatDeleteConfirmation).toBeNull();
		expect(callbacks.onDeleteChat).toHaveBeenCalledWith('chat-1');

		dialogs.requestRename(chat, 'New chat');
		await controller.confirmRename(dialogs, '  Renamed  ');

		expect(dialogs.chatRenameConfirmation).toBeNull();
		expect(callbacks.onRenameChat).toHaveBeenCalledWith('chat-1', 'Renamed');
		expect(callbacks.requestComposerFocus).toHaveBeenCalledOnce();
	});

	it('loads details into the active dialog and reports request failures there', async () => {
		const { controller } = createHarness();
		const dialogs = new ChatActionDialogsState();
		dialogs.requestDetails(makeChat(), 'New chat');
		vi.mocked(chatsApi.getChatDetails).mockResolvedValueOnce({
			chatId: 'chat-1',
			firstMessage: 'hello',
			createdAt: '2026-07-14T00:00:00.000Z',
			lastActivityAt: null,
			agentSessionId: 'session-1',
		});

		await controller.loadDetails('chat-1', dialogs);

		expect(dialogs.chatDetailsDialog).toMatchObject({
			firstMessage: 'hello',
			agentSessionId: 'session-1',
			isLoading: false,
			error: null,
		});

		dialogs.requestDetails(makeChat(), 'New chat');
		vi.mocked(chatsApi.getChatDetails).mockRejectedValueOnce(new Error('details unavailable'));
		await controller.loadDetails('chat-1', dialogs);

		expect(dialogs.chatDetailsDialog).toMatchObject({
			isLoading: false,
			error: 'details unavailable',
		});
	});

	it('updates tags and publishes the normalized project identity returned by the server', async () => {
		vi.mocked(chatsApi.updateChatProjectPath).mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			projectPath: '/workspace/canonical',
			effectiveProjectKey: '/workspace/canonical',
			previousProjectPath: '/workspace/repo',
			previousEffectiveProjectKey: '/workspace/repo',
		});
		const { controller, callbacks } = createHarness();

		await controller.updateTags('chat-1', ['review']);
		await controller.updateProjectPath('chat-1', ' /workspace/canonical ');

		expect(chatsApi.setChatTags).toHaveBeenCalledWith('chat-1', ['review']);
		expect(callbacks.onQuietRefresh).toHaveBeenCalledOnce();
		expect(chatsApi.updateChatProjectPath).toHaveBeenCalledWith({
			chatId: 'chat-1',
			projectPath: ' /workspace/canonical ',
		});
		expect(callbacks.onProjectPathUpdated).toHaveBeenCalledWith('chat-1', {
			projectPath: '/workspace/canonical',
			effectiveProjectKey: '/workspace/canonical',
		});
	});

	it('upserts and selects a server-confirmed fork', async () => {
		const fork = makeServerChat();
		vi.mocked(chatsApi.forkChat).mockResolvedValueOnce({ success: true, chat: fork });
		const { controller, callbacks } = createHarness();

		await controller.forkChat('chat-1');

		expect(chatsApi.forkChat).toHaveBeenCalledWith({
			sourceChatId: 'chat-1',
			chatId: 'fork-chat-id',
		});
		expect(callbacks.onUpsertServerChat).toHaveBeenCalledWith(fork);
		expect(callbacks.onSelectChat).toHaveBeenCalledWith('fork-chat-id');
	});

	it('runs optional reloads through the common user-visible failure boundary', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const reload = vi.fn().mockRejectedValue(new Error('reload failed'));
		const { controller, callbacks } = createHarness({ onReloadChat: reload });

		await controller.reloadChat('chat-1');

		expect(reload).toHaveBeenCalledWith('chat-1');
		expect(callbacks.notifyError).toHaveBeenCalledWith(m.sidebar_chats_reload_failed());

		const withoutReload = createHarness();
		await expect(withoutReload.controller.reloadChat('chat-1')).resolves.toBeUndefined();
	});
});
