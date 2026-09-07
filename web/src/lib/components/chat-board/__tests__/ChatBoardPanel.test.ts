import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatBoard, ChatBoardCatalog } from '$shared/chat-boards';
import type { ChatBoardApi } from '$lib/api/chat-boards';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte';
import { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub';
import { ApiError } from '$lib/api/client';
import ChatBoardPanelTestHost from './ChatBoardPanelTestHost.svelte';

const column = {
	id: '22222222-2222-4222-8222-222222222222',
	name: 'Ready',
	match: 'all' as const,
	tags: ['ready'],
};
const reviewColumn = {
	id: '33333333-3333-4333-8333-333333333333',
	name: 'Review',
	match: 'all' as const,
	tags: ['review'],
};
const board: ChatBoard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Delivery',
	columns: [column, reviewColumn],
};

function chat(): ChatSessionRecord {
	return {
		id: 'chat-1',
		parentChat: null,
		projectPath: '/workspace/project',
		orderGroup: 'normal',
		title: 'Polish onboarding',
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
		isProcessing: true,
		processingPhase: 'running',
		canReloadFromNativeHistory: false,
		isUnread: true,
		status: 'running',
		agentOwnershipEpoch: null,
		tags: ['ready'],
		lastMessage: 'Review the final interaction and spacing.',
	};
}

function createController(initial: ChatBoardCatalog) {
	let selectedBoardId: string | null = null;
	let itemLayout = null as 'compact' | 'detailed' | 'single-line' | null;
	let activeColumnId: string | null = null;
	const api = {
		load: vi.fn(async () => initial),
		create: vi.fn(async (_revision: number, name: string) => ({
			success: true as const,
			boardId: board.id,
			catalog: { revision: initial.revision + 1, boards: [{ ...board, name, columns: [] }] },
		})),
		update: vi.fn(),
		remove: vi.fn(),
		reorder: vi.fn(),
	} satisfies ChatBoardApi;
	const controller = new ChatBoardController({
		api,
		invalidations: new ChatBoardInvalidationHub(),
		preferences: {
			get selectedBoardId() {
				return selectedBoardId;
			},
			setSelectedBoardId(value) {
				selectedBoardId = value;
			},
			get itemLayout() {
				return itemLayout;
			},
			setItemLayout(value) {
				itemLayout = value;
			},
			getActiveColumnId() {
				return activeColumnId;
			},
			setActiveColumnId(_boardId, value) {
				activeColumnId = value;
			},
		},
		sidebarLayout: () => 'compact',
	});
	return { controller, api };
}

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.unstubAllGlobals();
});

describe('ChatBoardPanel', () => {
	it('shows a truthful first-run state and creates an unseeded board', async () => {
		const { controller, api } = createController({ revision: 0, boards: [] });
		await controller.refresh(true);
		const sessions = new ChatSessionsStore();
		sessions.chatListStatus = 'ready';
		render(ChatBoardPanelTestHost, { controller, sessions, onOpenChat: vi.fn() });

		expect(screen.getByText('Create your first board')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
		await fireEvent.input(screen.getByLabelText('Board name'), { target: { value: 'My work' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(api.create).toHaveBeenCalledWith(0, 'My work');
		expect(await screen.findByRole('dialog', { name: 'Edit columns' })).toBeTruthy();
	});

	it('renders live projected cards and opens a chat through its callback', async () => {
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const sessions = new ChatSessionsStore();
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		sessions.chatListStatus = 'ready';
		const onOpenChat = vi.fn();
		const { container } = render(ChatBoardPanelTestHost, { controller, sessions, onOpenChat });

		expect(screen.getByText('Ready')).toBeTruthy();
		expect(container.querySelector('[data-chat-board-occurrence]')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Open Polish onboarding' }));
		expect(onOpenChat).toHaveBeenCalledWith('chat-1');
		await fireEvent.click(screen.getByRole('button', { name: 'Transition…' }));
		expect(screen.getByRole('dialog', { name: 'Transition Chat' })).toBeTruthy();
	});

	it('offers an inline retry when saved tags could not be confirmed', async () => {
		const recoverChatTags = vi.fn()
			.mockRejectedValueOnce(new TypeError('Offline'))
			.mockResolvedValueOnce({ success: true as const, chatId: 'chat-1', tags: ['ready'] });
		const applyChatTagDelta = vi.fn().mockRejectedValue(
			new ApiError(503, 'Confirmation required', 'CHAT_TAG_SAVE_UNKNOWN'),
		);
		const sessions = new ChatSessionsStore({ applyChatTagDelta, recoverChatTags });
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		sessions.chatListStatus = 'ready';
		await expect(sessions.applyChatTagDelta({
			chatId: 'chat-1', addTags: ['review'],
		})).rejects.toMatchObject({ errorCode: 'CHAT_TAG_SAVE_UNKNOWN' });
		await waitFor(() => expect(recoverChatTags).toHaveBeenCalledTimes(1));

		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		render(ChatBoardPanelTestHost, { controller, sessions, onOpenChat: vi.fn() });
		await fireEvent.click(screen.getByRole('button', { name: /Confirming saved tags.*Try again/ }));

		await waitFor(() => expect(recoverChatTags).toHaveBeenCalledTimes(2));
		expect(await screen.findByText('Saved tags confirmed.')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Confirming saved tags.*Try again/ })).toBeNull();
	});

	it('implements narrow lane tabs without changing selection during arrow-key focus', async () => {
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(
					private readonly callback: (
						entries: readonly { contentRect: { width: number } }[],
					) => void,
				) {}
				observe(element: Element) {
					if (element.matches('[data-chat-board-panel]')) {
						this.callback([{ contentRect: { width: 420 } }]);
					}
				}
				unobserve() {}
				disconnect() {}
			},
		);
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const selectColumn = vi.spyOn(controller, 'selectColumn');
		const sessions = new ChatSessionsStore();
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		sessions.chatListStatus = 'ready';
		render(ChatBoardPanelTestHost, { controller, sessions, onOpenChat: vi.fn() });
		const readyTab = await screen.findByRole('tab', { name: 'Ready 1' });
		const reviewTab = screen.getByRole('tab', { name: 'Review 0' });
		readyTab.focus();
		await fireEvent.keyDown(readyTab, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(reviewTab);
		expect(selectColumn).not.toHaveBeenCalled();
		await fireEvent.keyDown(reviewTab, { key: 'Enter' });
		expect(selectColumn).toHaveBeenCalledWith(reviewColumn.id);
	});

	it('updates processing in place without replacing the focused card or lane scroll', async () => {
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const sessions = new ChatSessionsStore();
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		sessions.chatListStatus = 'ready';
		const { container } = render(ChatBoardPanelTestHost, {
			controller,
			sessions,
			onOpenChat: vi.fn(),
		});

		const card = container.querySelector<HTMLElement>('[data-chat-board-occurrence]')!;
		const open = screen.getByRole('button', { name: 'Open Polish onboarding' });
		const lane = container.querySelector<HTMLElement>('[data-chat-board-lane-list]')!;
		open.focus();
		lane.scrollTop = 24;
		sessions.applyProcessingEvent('chat-1', null);

		await waitFor(() => expect(sessions.byId['chat-1']?.isProcessing).toBe(false));
		expect(container.querySelector('[data-chat-board-occurrence]')).toBe(card);
		expect(document.activeElement).toBe(open);
		expect(lane.scrollTop).toBe(24);
	});
});
