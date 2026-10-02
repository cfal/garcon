import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { ChatListEntry } from '$shared/chat-list';
import {
	ChatActionController,
	type ChatActionControllerDeps,
} from '../chat-action-controller.svelte.ts';
import { ChatActionDialogsState } from '../chat-action-dialogs-state.svelte';
import { resolveProject } from '$lib/api/project-resolution';

vi.mock('$lib/api/project-resolution', () => ({ resolveProject: vi.fn() }));

function projectDialog(chat = makeChat()) {
	const dialogs = new ChatActionDialogsState();
	dialogs.requestProjectPath(chat, 'Chat');
	return dialogs.chatProjectPathDialog!;
}

vi.mock('$lib/api/chats', () => ({
	deleteChat: vi.fn(),
	forkChat: vi.fn(),
	getChatDetails: vi.fn(),
	reorderChat: vi.fn(),
	toggleArchive: vi.fn(),
	togglePinned: vi.fn(),
	updateChatProjectPath: vi.fn(),
}));

vi.mock('$shared/client-chat-id', () => ({
	createClientChatId: () => 'fork-chat-id',
}));

function makeChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/repo',
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
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'running',
		tags: [],
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch:
			overrides.agentOwnershipEpoch === undefined ? 'epoch-1' : overrides.agentOwnershipEpoch,
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
		orderGroup: 'normal',
		tags: [],
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch:
			overrides.agentOwnershipEpoch === undefined ? 'epoch-1' : overrides.agentOwnershipEpoch,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

it('resolves draft folder changes without rewriting filesystem identity', async () => {
	const draft = makeChat({ status: 'draft', projectPath: '/previous ' });
	const target = { kind: 'path' as const, executorId: 'local', projectPath: '/next ' };
	vi.mocked(resolveProject).mockResolvedValueOnce({
		target, resolution: { kind: 'available', effectiveProjectKey: target.projectPath },
	});
	const { controller, callbacks } = createHarness({ chats: [draft] });
	await controller.updateProjectPath(projectDialog(draft), target.projectPath);
	expect(resolveProject).toHaveBeenCalledWith(target, expect.anything());
	expect(callbacks.onProjectPathUpdated).toHaveBeenCalledWith(draft.id, { projectPath: target.projectPath });
});

function createHarness(
	options: {
		chats?: ChatSessionRecord[];
		displayedChatIds?: readonly string[];
		selectedChatId?: string | null;
		onReloadChat?: (chatId: string) => Promise<void> | void;
	} = {},
) {
	const chats = options.chats ?? [makeChat()];
	let selectedChatId =
		options.selectedChatId === undefined ? (chats[0]?.id ?? null) : options.selectedChatId;
	const callbacks = {
		projectPathRevision: vi.fn(() => 0),
		onQuietRefresh: vi.fn(async () => undefined),
		onSelectChat: vi.fn(),
		onNewChat: vi.fn(),
		onDeleteChat: vi.fn(async () => undefined),
		onRenameChat: vi.fn(async () => undefined),
		onProjectPathUpdated: vi.fn(),
		onUpsertServerChat: vi.fn(),
		replaceChatTags: vi.fn(async (input) => ({
			success: true as const,
			chatId: input.chatId,
			tags: [...input.tags],
			addedTags: [...input.tags],
			removedTags: [],
		})),
		notifyError: vi.fn(),
		dismissProgress: vi.fn(),
		showProgress: vi.fn((): (() => void) => callbacks.dismissProgress),
		requestComposerFocus: vi.fn(),
		requestSidebarRecenter: vi.fn(),
	};
	const pendingArchiveIds = new Set<string>();
	function startArchiveMutation(chatIds: readonly string[]) {
		const admittedIds = chatIds.filter((chatId) => !pendingArchiveIds.has(chatId));
		for (const chatId of admittedIds) pendingArchiveIds.add(chatId);
		const completion = (async () => {
			try {
				await Promise.all(admittedIds.map((chatId) => chatsApi.toggleArchive(chatId)));
				await callbacks.onQuietRefresh();
			} finally {
				for (const chatId of admittedIds) pendingArchiveIds.delete(chatId);
			}
		})();
		return { chatIds: admittedIds, completion };
	}
	const deps = {
		get chats() {
			return chats;
		},
		get displayedChatIds() {
			return options.displayedChatIds ?? chats.map((chat) => chat.id);
		},
		get selectedChatId() {
			return selectedChatId;
		},
		isArchiveMutationPending: (chatId: string) => pendingArchiveIds.has(chatId),
		startArchivingChats: startArchiveMutation,
		startUnarchivingChats: startArchiveMutation,
		...callbacks,
		onReloadChat: options.onReloadChat,
	} satisfies ChatActionControllerDeps;

	return {
		controller: new ChatActionController(deps),
		callbacks,
		chats,
		setSelectedChatId(chatId: string | null) {
			selectedChatId = chatId;
		},
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(chatsApi.togglePinned).mockResolvedValue({ success: true, isPinned: true });
	vi.mocked(chatsApi.toggleArchive).mockResolvedValue({ success: true, isArchived: true });
});

describe('ChatActionController', () => {
	it('reports a failed pin without refreshing or recentering', async () => {
		const { controller, callbacks } = createHarness();
		vi.mocked(chatsApi.togglePinned).mockRejectedValueOnce(new Error('Pin failed'));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await controller.togglePinned('chat-1');
			expect(callbacks.notifyError).toHaveBeenCalledWith(expect.stringContaining('Pin failed'));
			expect(callbacks.onQuietRefresh).not.toHaveBeenCalled();
			expect(callbacks.requestSidebarRecenter).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
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

	it('selects the next neighbor before archiving and never reapplies that selection', async () => {
		const chats = [
			makeChat({ id: 'first' }),
			makeChat({ id: 'selected' }),
			makeChat({ id: 'next' }),
		];
		const archive = deferred<Awaited<ReturnType<typeof chatsApi.toggleArchive>>>();
		vi.mocked(chatsApi.toggleArchive).mockReturnValueOnce(archive.promise);
		const { controller, callbacks, setSelectedChatId } = createHarness({
			chats,
			selectedChatId: 'selected',
		});

		const completion = controller.toggleArchive('selected');

		expect(chatsApi.toggleArchive).toHaveBeenCalledWith('selected');
		expect(callbacks.onSelectChat).toHaveBeenCalledOnce();
		expect(callbacks.onSelectChat).toHaveBeenCalledWith('next');
		expect(callbacks.onNewChat).not.toHaveBeenCalled();

		setSelectedChatId('manually-selected');
		archive.resolve({ success: true, isArchived: true });
		await completion;

		expect(callbacks.onQuietRefresh).toHaveBeenCalledOnce();
		expect(callbacks.onSelectChat).toHaveBeenCalledOnce();
	});

	it('selects an adjacent chat from the displayed recent-activity order', async () => {
		const { controller, callbacks } = createHarness({
			chats: [
				makeChat({ id: 'selected' }),
				makeChat({ id: 'manual-order-neighbor' }),
				makeChat({ id: 'recent-order-neighbor' }),
			],
			displayedChatIds: ['manual-order-neighbor', 'selected', 'recent-order-neighbor'],
			selectedChatId: 'selected',
		});

		await controller.toggleArchive('selected');

		expect(callbacks.onSelectChat).toHaveBeenCalledOnce();
		expect(callbacks.onSelectChat).toHaveBeenCalledWith('recent-order-neighbor');
	});

	it('creates a new chat when archiving the only selected chat', async () => {
		const archive = deferred<Awaited<ReturnType<typeof chatsApi.toggleArchive>>>();
		vi.mocked(chatsApi.toggleArchive).mockReturnValueOnce(archive.promise);
		const { controller, callbacks } = createHarness();

		const completion = controller.toggleArchive('chat-1');

		expect(callbacks.onNewChat).toHaveBeenCalledOnce();
		expect(callbacks.onSelectChat).not.toHaveBeenCalled();

		archive.resolve({ success: true, isArchived: true });
		await completion;
		expect(callbacks.onNewChat).toHaveBeenCalledOnce();
	});

	it('ignores a duplicate archive while the first mutation is pending', async () => {
		const archive = deferred<Awaited<ReturnType<typeof chatsApi.toggleArchive>>>();
		vi.mocked(chatsApi.toggleArchive).mockReturnValueOnce(archive.promise);
		const { controller, callbacks } = createHarness({
			chats: [makeChat({ id: 'selected' }), makeChat({ id: 'next' })],
			selectedChatId: 'selected',
		});

		const firstCompletion = controller.toggleArchive('selected');
		await controller.toggleArchive('selected');

		expect(chatsApi.toggleArchive).toHaveBeenCalledOnce();
		expect(callbacks.onSelectChat).toHaveBeenCalledOnce();
		archive.resolve({ success: true, isArchived: true });
		await firstCompletion;
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

	it('does not recenter after unarchive when the user selects another chat', async () => {
		const archive = deferred<Awaited<ReturnType<typeof chatsApi.toggleArchive>>>();
		vi.mocked(chatsApi.toggleArchive).mockReturnValueOnce(archive.promise);
		const { controller, callbacks, setSelectedChatId } = createHarness({
			chats: [makeChat({ isArchived: true })],
			selectedChatId: 'chat-1',
		});

		const completion = controller.toggleArchive('chat-1');
		setSelectedChatId('manually-selected');
		archive.resolve({ success: true, isArchived: false });
		await completion;

		expect(callbacks.requestSidebarRecenter).not.toHaveBeenCalled();
	});

	it('retains immediate archive navigation when the mutation fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(chatsApi.toggleArchive).mockRejectedValueOnce(new Error('offline'));
		const { controller, callbacks } = createHarness({
			chats: [makeChat({ id: 'selected' }), makeChat({ id: 'next' })],
			selectedChatId: 'selected',
		});

		await controller.toggleArchive('selected');

		expect(callbacks.notifyError).toHaveBeenCalledWith(
			m.notifications_archive_chat_failed({ detail: 'offline' }),
		);
		expect(callbacks.onSelectChat).toHaveBeenCalledOnce();
		expect(callbacks.onSelectChat).toHaveBeenCalledWith('next');
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
			transcriptSource: null,
			carryOver: {
				revision: 'carry-v1:0',
				archivedMessageCount: 0,
				segments: [],
			},
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

	it('updates tags and publishes the normalized project path returned by the server', async () => {
		vi.mocked(chatsApi.updateChatProjectPath).mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			projectPath: '/workspace/canonical',
			effectiveProjectKey: '/workspace/canonical',
			previousProjectPath: '/workspace/repo',
		});
		const { controller, callbacks } = createHarness();

		await controller.updateTags('chat-1', ['existing'], ['review']);
		await controller.updateProjectPath(projectDialog(), ' /workspace/canonical ');

		expect(callbacks.replaceChatTags).toHaveBeenCalledWith({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['review'],
		});
		expect(chatsApi.updateChatProjectPath).toHaveBeenCalledWith({
			chatId: 'chat-1',
			projectPath: ' /workspace/canonical ',
			expectedExecutorId: 'local',
			expectedAgentOwnershipEpoch: 'epoch-1',
			expectedProjectPath: '/workspace/repo',
		});
		expect(callbacks.onProjectPathUpdated).toHaveBeenCalledWith('chat-1', {
			projectPath: '/workspace/canonical',
		});
	});

	it('does not apply a PATCH result after a newer WebSocket path', async () => {
		const pending = deferred<Awaited<ReturnType<typeof chatsApi.updateChatProjectPath>>>();
		vi.mocked(chatsApi.updateChatProjectPath).mockReturnValueOnce(pending.promise);
		const { controller, callbacks, chats } = createHarness();
		const update = controller.updateProjectPath(projectDialog(), '/workspace/requested');
		chats[0] = makeChat({ projectPath: '/workspace/newer' });
		pending.resolve({
			success: true,
			chatId: 'chat-1',
			projectPath: '/workspace/requested',
			effectiveProjectKey: '/workspace/requested',
			previousProjectPath: '/workspace/repo',
		});

		await update;

		expect(callbacks.onProjectPathUpdated).not.toHaveBeenCalled();
	});

	it('applies a PATCH result idempotently after the same WebSocket path', async () => {
		const pending = deferred<Awaited<ReturnType<typeof chatsApi.updateChatProjectPath>>>();
		vi.mocked(chatsApi.updateChatProjectPath).mockReturnValueOnce(pending.promise);
		const { controller, callbacks, chats } = createHarness();
		const update = controller.updateProjectPath(projectDialog(), '/workspace/requested');
		chats[0] = makeChat({ projectPath: '/workspace/requested' });
		pending.resolve({
			success: true,
			chatId: 'chat-1',
			projectPath: '/workspace/requested',
			effectiveProjectKey: '/workspace/requested',
			previousProjectPath: '/workspace/repo',
		});

		await update;

		expect(callbacks.onProjectPathUpdated).toHaveBeenCalledWith('chat-1', {
			projectPath: '/workspace/requested',
		});
	});

	it('does not apply a PATCH result after an observed A/B/A binding sequence', async () => {
		const pending = deferred<Awaited<ReturnType<typeof chatsApi.updateChatProjectPath>>>();
		vi.mocked(chatsApi.updateChatProjectPath).mockReturnValueOnce(pending.promise);
		const { controller, callbacks, chats } = createHarness();
		const update = controller.updateProjectPath(projectDialog(), '/workspace/requested');
		chats[0] = makeChat({ projectPath: '/workspace/temporary' });
		callbacks.projectPathRevision.mockReturnValue(1);
		chats[0] = makeChat({ projectPath: '/workspace/repo' });
		callbacks.projectPathRevision.mockReturnValue(2);
		pending.resolve({
			success: true,
			chatId: 'chat-1',
			projectPath: '/workspace/requested',
			effectiveProjectKey: '/workspace/requested',
			previousProjectPath: '/workspace/repo',
		});

		await update;

		expect(callbacks.onProjectPathUpdated).not.toHaveBeenCalled();
	});

	it('lets a second project-path request supersede the first', async () => {
		const first = deferred<Awaited<ReturnType<typeof chatsApi.updateChatProjectPath>>>();
		const second = deferred<Awaited<ReturnType<typeof chatsApi.updateChatProjectPath>>>();
		vi.mocked(chatsApi.updateChatProjectPath)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { controller, callbacks } = createHarness();
		const firstUpdate = controller.updateProjectPath(projectDialog(), '/workspace/first');
		const secondUpdate = controller.updateProjectPath(projectDialog(), '/workspace/second');
		second.resolve({
			success: true,
			chatId: 'chat-1',
			projectPath: '/workspace/second',
			effectiveProjectKey: '/workspace/second',
			previousProjectPath: '/workspace/repo',
		});
		await secondUpdate;
		first.resolve({
			success: true,
			chatId: 'chat-1',
			projectPath: '/workspace/first',
			effectiveProjectKey: '/workspace/first',
			previousProjectPath: '/workspace/repo',
		});
		await firstUpdate;

		expect(callbacks.onProjectPathUpdated).toHaveBeenCalledOnce();
		expect(callbacks.onProjectPathUpdated).toHaveBeenCalledWith('chat-1', {
			projectPath: '/workspace/second',
		});
	});

	it('rejects project-path updates without a current binding', async () => {
		const missing = createHarness({ chats: [] });
		const empty = createHarness({ chats: [makeChat({ projectPath: '' })] });

		await expect(
			missing.controller.updateProjectPath(projectDialog(), '/workspace/new'),
		).rejects.toThrow(m.sidebar_project_path_errors_target_changed());
		await expect(
			empty.controller.updateProjectPath(projectDialog(), '/workspace/new'),
		).rejects.toThrow(m.sidebar_project_path_errors_target_changed());
		expect(chatsApi.updateChatProjectPath).not.toHaveBeenCalled();
	});

	it.each([
		{ executorId: '22222222-2222-4222-8222-222222222222' },
		{ agentOwnershipEpoch: 'next-owner' },
		{ projectPath: '/other' },
	])('rejects a stale folder dialog before dispatch: %j', async (change) => {
		const { controller, chats } = createHarness();
		const target = projectDialog(chats[0]);
		chats[0] = makeChat(change);
		await expect(controller.updateProjectPath(target, '/chosen')).rejects.toThrow(
			m.sidebar_project_path_errors_target_changed(),
		);
		expect(chatsApi.updateChatProjectPath).not.toHaveBeenCalled();
	});

	it('does not publish an old owner response even when the new owner uses the returned path', async () => {
		const pending = deferred<Awaited<ReturnType<typeof chatsApi.updateChatProjectPath>>>();
		vi.mocked(chatsApi.updateChatProjectPath).mockReturnValueOnce(pending.promise);
		const { controller, callbacks, chats } = createHarness();
		const updating = controller.updateProjectPath(projectDialog(chats[0]), '/chosen');
		chats[0] = makeChat({ projectPath: '/chosen', agentOwnershipEpoch: 'new-owner' });
		pending.resolve({
			success: true,
			chatId: 'chat-1',
			projectPath: '/chosen',
			effectiveProjectKey: '/chosen',
			previousProjectPath: '/workspace/repo',
		});
		await updating;
		expect(callbacks.onProjectPathUpdated).not.toHaveBeenCalled();
	});

	it.each(['local', '22222222-2222-4222-8222-222222222222'])(
		'repairs a browser draft using only path validation on %s',
		async (executorId) => {
			const draft = makeChat({ status: 'draft', executorId, agentOwnershipEpoch: null });
			const { controller, callbacks } = createHarness({ chats: [draft] });
			vi.mocked(resolveProject).mockImplementationOnce(async (target) => ({
				target,
				resolution: { kind: 'available', effectiveProjectKey: '/canonical' },
			}));
			await controller.updateProjectPath(projectDialog(draft), '/chosen');
			expect(resolveProject).toHaveBeenLastCalledWith(
				{ kind: 'path', executorId, projectPath: '/chosen' },
				expect.any(AbortSignal),
			);
			expect(chatsApi.updateChatProjectPath).not.toHaveBeenCalled();
			expect(callbacks.onProjectPathUpdated).toHaveBeenCalledWith(draft.id, {
				projectPath: '/canonical',
			});
		},
	);

	it.each(['promotion', 'retarget', 'path-change', 'unavailable'])(
		'does not apply draft validation after %s',
		async (change) => {
			const draft = makeChat({ status: 'draft' });
			const pending = deferred<Awaited<ReturnType<typeof resolveProject>>>();
			vi.mocked(resolveProject).mockReturnValueOnce(pending.promise);
			const { controller, callbacks, chats } = createHarness({ chats: [draft] });
			const updating = controller.updateProjectPath(projectDialog(draft), '/chosen');
			if (change === 'promotion') chats[0] = makeChat({ status: 'running' });
			if (change === 'retarget') chats[0] = { ...draft, executorId: 'another-executor' };
			if (change === 'path-change') chats[0] = { ...draft, projectPath: '/other' };
			pending.resolve({
				target: { kind: 'path', executorId: 'local', projectPath: '/chosen' },
				resolution:
					change === 'unavailable'
						? { kind: 'unavailable', reason: 'not-found' }
						: { kind: 'available', effectiveProjectKey: '/chosen' },
			});
			if (change === 'unavailable') await expect(updating).rejects.toThrow();
			else await updating;
			expect(callbacks.onProjectPathUpdated).not.toHaveBeenCalled();
			expect(chatsApi.updateChatProjectPath).not.toHaveBeenCalled();
		},
	);

	it('upserts and selects a server-confirmed fork', async () => {
		const fork = makeServerChat();
		vi.mocked(chatsApi.forkChat).mockResolvedValueOnce({ success: true, chat: fork });
		const { controller, callbacks } = createHarness();

		await controller.forkChat('chat-1');

		expect(chatsApi.forkChat).toHaveBeenCalledWith({
			sourceChatId: 'chat-1',
			chatId: 'fork-chat-id',
			clientRequestId: expect.any(String),
		});
		expect(callbacks.onUpsertServerChat).toHaveBeenCalledWith(fork);
		expect(callbacks.onSelectChat).toHaveBeenCalledWith('fork-chat-id');
	});

	it('shows fork progress until the fork settles and ignores a repeated fork meanwhile', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const response = deferred<Awaited<ReturnType<typeof chatsApi.forkChat>>>();
		vi.mocked(chatsApi.forkChat).mockReturnValueOnce(response.promise);
		const { controller, callbacks } = createHarness();

		const forking = controller.forkChat('chat-1');
		await controller.forkChat('chat-1');

		expect(chatsApi.forkChat).toHaveBeenCalledTimes(1);
		expect(callbacks.showProgress).toHaveBeenCalledExactlyOnceWith(
			'fork:chat-1',
			m.chat_notice_forking_chat(),
		);
		expect(callbacks.dismissProgress).not.toHaveBeenCalled();
		response.reject(new ApiError(503, 'Executor is unavailable', 'EXECUTOR_UNAVAILABLE'));
		await forking;

		expect(callbacks.dismissProgress).toHaveBeenCalledOnce();
		expect(callbacks.notifyError).toHaveBeenCalledWith(
			m.chat_notice_failed_fork_chat({ detail: 'Executor is unavailable' }),
		);
		vi.mocked(chatsApi.forkChat).mockResolvedValueOnce({ success: true, chat: makeServerChat() });
		await controller.forkChat('chat-1');
		expect(chatsApi.forkChat).toHaveBeenCalledTimes(2);
	});

	it('retries a lost fork reply into the same target chat', async () => {
		const fork = makeServerChat();
		vi.mocked(chatsApi.forkChat)
			.mockRejectedValueOnce(new TypeError('connection reset'))
			.mockResolvedValueOnce({ success: true, chat: fork });
		const { controller, callbacks } = createHarness();

		await controller.forkChat('chat-1');

		const [[first], [retry]] = vi.mocked(chatsApi.forkChat).mock.calls;
		expect(first).toEqual({
			sourceChatId: 'chat-1',
			chatId: 'fork-chat-id',
			clientRequestId: expect.any(String),
		});
		expect(retry).toEqual(first);
		expect(callbacks.onSelectChat).toHaveBeenCalledWith('fork-chat-id');
		expect(callbacks.notifyError).not.toHaveBeenCalled();
	});

	it('reports an unconfirmed fork after two lost replies', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(chatsApi.forkChat).mockRejectedValue(new TypeError('connection reset'));
		const { controller, callbacks } = createHarness();

		await controller.forkChat('chat-1');

		expect(callbacks.notifyError).toHaveBeenCalledWith(m.chat_notice_fork_outcome_unconfirmed());
		expect(callbacks.onSelectChat).not.toHaveBeenCalled();
	});

	it.each([
		['confirms', true],
		['declines', false],
	])('asks before a handoff fork and follows what the user %s', async (_label, confirmed) => {
		const fork = makeServerChat();
		vi.mocked(chatsApi.forkChat)
			.mockRejectedValueOnce(
				new ApiError(409, 'not materialized', 'TRANSCRIPT_NOT_YET_PERSISTED', undefined, true),
			)
			.mockResolvedValueOnce({ success: true, chat: fork });
		const { controller, callbacks } = createHarness();

		const forking = controller.forkChat('chat-1');
		await vi.waitFor(() => expect(controller.handoffForkConfirmation.isOpen).toBe(true));
		if (confirmed) controller.handoffForkConfirmation.confirm();
		else controller.handoffForkConfirmation.cancel();
		await forking;

		if (confirmed) {
			expect(chatsApi.forkChat).toHaveBeenLastCalledWith({
				...vi.mocked(chatsApi.forkChat).mock.calls[0]?.[0],
				allowHandoffFork: true,
			});
			expect(callbacks.onSelectChat).toHaveBeenCalledWith('fork-chat-id');
		} else {
			expect(chatsApi.forkChat).toHaveBeenCalledOnce();
			expect(callbacks.onSelectChat).not.toHaveBeenCalled();
		}
		expect(callbacks.notifyError).not.toHaveBeenCalled();
		expect(callbacks.dismissProgress).toHaveBeenCalledOnce();
	});

	it('runs optional reloads through the common user-visible failure boundary', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const reload = vi.fn().mockRejectedValue(new Error('reload failed'));
		const { controller, callbacks } = createHarness({ onReloadChat: reload });

		await controller.reloadChat('chat-1');

		expect(reload).toHaveBeenCalledWith('chat-1');
		expect(callbacks.notifyError).toHaveBeenCalledWith(
			m.sidebar_chats_reload_failed({ detail: 'reload failed' }),
		);

		const withoutReload = createHarness();
		await expect(withoutReload.controller.reloadChat('chat-1')).resolves.toBeUndefined();
	});
});
