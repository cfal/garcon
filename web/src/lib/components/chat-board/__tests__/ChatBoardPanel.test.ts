import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatBoard, ChatBoardCatalog } from '$shared/chat-boards';
import type { ChatBoardApi } from '$lib/api/chat-boards';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte';
import { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub';
import { ApiError } from '$lib/api/client';
import { tick } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { getChatBoardPanelMemory } from '../chat-board-panel-memory.js';
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

function chat(id = 'chat-1', title = 'Polish onboarding'): ChatSessionRecord {
	return {
		id,
		parentChat: null,
		projectPath: '/workspace/project',
		orderGroup: 'normal',
		title,
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

function emulateDetachedChromiumScrollReset(element: HTMLElement): void {
	let connectedScrollTop = element.scrollTop;
	Object.defineProperty(element, 'scrollTop', {
		configurable: true,
		get() {
			return element.isConnected ? connectedScrollTop : 0;
		},
		set(value: number) {
			connectedScrollTop = value;
		},
	});
}

function nextAnimationFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function stubPanelWidth(width: number): void {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(
				private readonly callback: (entries: readonly { contentRect: { width: number } }[]) => void,
			) {}

			observe(element: Element): void {
				if (element.matches('[data-chat-board-panel]')) {
					this.callback([{ contentRect: { width } }]);
				}
			}

			unobserve(): void {}
			disconnect(): void {}
		},
	);
}

function createController(initial: ChatBoardCatalog) {
	let current = initial;
	let selectedBoardId: string | null = null;
	let itemLayout = null as 'compact' | 'detailed' | 'single-line' | null;
	const activeColumnIds = new SvelteMap<string, string>();
	const api = {
		load: vi.fn(async () => current),
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
			getActiveColumnId(boardId) {
				return activeColumnIds.get(boardId) ?? null;
			},
			setActiveColumnId(boardId, value) {
				if (value) activeColumnIds.set(boardId, value);
				else activeColumnIds.delete(boardId);
			},
			pruneActiveColumns() {},
		},
		sidebarLayout: () => 'compact',
	});
	return {
		controller,
		api,
		setCatalog(catalog: ChatBoardCatalog) {
			current = catalog;
		},
	};
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
		const recoverChatTags = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Offline'))
			.mockResolvedValueOnce({ success: true as const, chatId: 'chat-1', tags: ['ready'] });
		const applyChatTagDelta = vi
			.fn()
			.mockRejectedValue(new ApiError(503, 'Confirmation required', 'CHAT_TAG_SAVE_UNKNOWN'));
		const sessions = new ChatSessionsStore({ applyChatTagDelta, recoverChatTags });
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		sessions.chatListStatus = 'ready';
		await expect(
			sessions.applyChatTagDelta({
				chatId: 'chat-1',
				addTags: ['review'],
			}),
		).rejects.toMatchObject({ errorCode: 'CHAT_TAG_SAVE_UNKNOWN' });
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
		stubPanelWidth(420);
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
		await tick();
		open.focus();
		lane.scrollTop = 24;
		await fireEvent.scroll(lane);
		await nextAnimationFrame();
		sessions.applyProcessingEvent('chat-1', null);

		await waitFor(() => expect(sessions.byId['chat-1']?.isProcessing).toBe(false));
		expect(container.querySelector('[data-chat-board-occurrence]')).toBe(card);
		expect(document.activeElement).toBe(open);
		expect(lane.scrollTop).toBe(24);
	});

	it('restores focus to the source lane when a dialog invoker disappears', async () => {
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const sessions = new ChatSessionsStore();
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		sessions.chatListStatus = 'ready';
		render(ChatBoardPanelTestHost, { controller, sessions, onOpenChat: vi.fn() });
		await fireEvent.click(screen.getByRole('button', { name: 'Transition…' }));

		sessions.byId = { 'chat-1': { ...chat(), tags: ['elsewhere'] } };
		await tick();
		expect(screen.queryByRole('button', { name: 'Open Polish onboarding' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Ready' })),
		);
	});

	it('restores focus to the surviving transition invoker when the dialog closes', async () => {
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const sessions = new ChatSessionsStore();
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		sessions.chatListStatus = 'ready';
		render(ChatBoardPanelTestHost, { controller, sessions, onOpenChat: vi.fn() });
		const invoker = screen.getByRole('button', { name: 'Transition…' });
		await fireEvent.click(invoker);

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(() => expect(document.activeElement).toBe(invoker));
	});

	it('keeps independent lane scroll positions across lane and presentation changes', async () => {
		class TestResizeObserver {
			static emit: (width: number) => void = () => {};
			readonly #callback: (entries: readonly { contentRect: { width: number } }[]) => void;

			constructor(callback: (entries: readonly { contentRect: { width: number } }[]) => void) {
				this.#callback = callback;
			}

			observe(element: Element) {
				if (element.matches('[data-chat-board-panel]')) {
					TestResizeObserver.emit = (width) => this.#callback([{ contentRect: { width } }]);
				}
			}
			unobserve() {}
			disconnect() {}
		}
		vi.stubGlobal('ResizeObserver', TestResizeObserver);
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
		const readySelector = `[data-chat-board-lane-list="${column.id}"]`;
		const reviewSelector = `[data-chat-board-lane-list="${reviewColumn.id}"]`;
		const panel = container.querySelector<HTMLElement>('[data-chat-board-panel]')!;
		let panelWidth = 700;
		vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(
			() => ({ width: panelWidth }) as DOMRect,
		);
		const ready = container.querySelector<HTMLElement>(readySelector)!;
		const review = container.querySelector<HTMLElement>(reviewSelector)!;
		emulateDetachedChromiumScrollReset(ready);
		emulateDetachedChromiumScrollReset(review);
		ready.scrollTop = 37;
		review.scrollTop = 83;
		await fireEvent.scroll(ready);
		await fireEvent.scroll(review);
		await nextAnimationFrame();

		panelWidth = 420;
		ready.scrollTop = 0;
		await fireEvent.scroll(ready);
		TestResizeObserver.emit(panelWidth);
		await waitFor(() =>
			expect(container.querySelector<HTMLElement>(readySelector)?.scrollTop).toBe(37),
		);
		await fireEvent.click(screen.getByRole('tab', { name: 'Review 0' }));
		await waitFor(() =>
			expect(container.querySelector<HTMLElement>(reviewSelector)?.scrollTop).toBe(83),
		);

		panelWidth = 700;
		TestResizeObserver.emit(panelWidth);
		await waitFor(() => {
			expect(container.querySelector<HTMLElement>(readySelector)?.scrollTop).toBe(37);
			expect(container.querySelector<HTMLElement>(reviewSelector)?.scrollTop).toBe(83);
		});
	});

	it('restores lane scroll and focused controls across presentation host remounts', async () => {
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const sessions = new ChatSessionsStore();
		sessions.byId = { 'chat-1': chat() };
		sessions.order = ['chat-1'];
		sessions.chatListStatus = 'ready';
		const firstView = render(ChatBoardPanelTestHost, {
			controller,
			sessions,
			onOpenChat: vi.fn(),
			presentation: 'window-main',
		});
		const lane = firstView.container.querySelector<HTMLElement>(
			`[data-chat-board-lane-list="${column.id}"]`,
		)!;
		lane.scrollTop = 63;
		await fireEvent.scroll(lane);
		await nextAnimationFrame();
		const transition = screen.getByRole('button', { name: 'Transition…' });
		transition.focus();
		firstView.unmount();

		const mobileView = render(ChatBoardPanelTestHost, {
			controller,
			sessions,
			onOpenChat: vi.fn(),
			presentation: 'mobile',
		});
		await waitFor(() =>
			expect(
				mobileView.container.querySelector<HTMLElement>(
					`[data-chat-board-lane-list="${column.id}"]`,
				)?.scrollTop,
			).toBe(63),
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Transition…' })),
		);
	});

	it('does not restore an old host bookmark after new keyboard focus', async () => {
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		getChatBoardPanelMemory(controller).focusTarget = { kind: 'lane', columnId: column.id };
		const sessions = new ChatSessionsStore();
		sessions.chatListStatus = 'ready';
		render(ChatBoardPanelTestHost, { controller, sessions, onOpenChat: vi.fn() });
		const reviewHeading = screen.getByRole('heading', { name: 'Review' });

		await fireEvent.keyDown(reviewHeading, { key: 'Shift' });
		reviewHeading.focus();
		await nextAnimationFrame();
		await nextAnimationFrame();

		expect(document.activeElement).toBe(reviewHeading);
		expect(getChatBoardPanelMemory(controller).focusTarget).toEqual({
			kind: 'lane',
			columnId: reviewColumn.id,
		});
	});

	it('retains an offscreen occurrence bookmark until host focus restoration', async () => {
		stubPanelWidth(420);
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const sessions = new ChatSessionsStore();
		const chats = Array.from({ length: 100 }, (_, index) => chat(`chat-${index}`, `Chat ${index}`));
		sessions.byId = Object.fromEntries(chats.map((record) => [record.id, record]));
		sessions.order = chats.map((record) => record.id);
		sessions.chatListStatus = 'ready';
		getChatBoardPanelMemory(controller).focusTarget = {
			kind: 'occurrence',
			columnId: column.id,
			occurrenceKey: `${column.id}:chat-99`,
			control: 'transition',
		};
		const { container } = render(ChatBoardPanelTestHost, {
			controller,
			sessions,
			onOpenChat: vi.fn(),
			presentation: 'mobile',
		});

		const restored = container.querySelector<HTMLElement>(
			`[data-chat-board-chat-id="chat-99"] [data-chat-board-focus-target="transition"]`,
		);
		expect(restored).toBeTruthy();
		await waitFor(() => expect(document.activeElement).toBe(restored));
	});

	it('does not restore scroll memory for a column deleted during host mounting', async () => {
		const { controller, setCatalog } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const memory = getChatBoardPanelMemory(controller);
		const readyKey = `${board.id}:${column.id}`;
		const reviewKey = `${board.id}:${reviewColumn.id}`;
		memory.laneScrollOffsets.set(readyKey, 37);
		memory.laneScrollOffsets.set(reviewKey, 83);
		const sessions = new ChatSessionsStore();
		sessions.chatListStatus = 'ready';
		render(ChatBoardPanelTestHost, { controller, sessions, onOpenChat: vi.fn() });

		setCatalog({ revision: 2, boards: [{ ...board, columns: [column] }] });
		await controller.refresh(false);
		await nextAnimationFrame();
		await nextAnimationFrame();
		await nextAnimationFrame();

		expect(memory.laneScrollOffsets.get(readyKey)).toBe(37);
		expect(memory.laneScrollOffsets.has(reviewKey)).toBe(false);
	});

	it('keeps a focused card mounted when live ordering moves it outside the virtual range', async () => {
		stubPanelWidth(420);
		const { controller } = createController({ revision: 1, boards: [board] });
		await controller.refresh(true);
		const sessions = new ChatSessionsStore();
		const chats = Array.from({ length: 100 }, (_, index) => chat(`chat-${index}`, `Chat ${index}`));
		sessions.byId = Object.fromEntries(chats.map((record) => [record.id, record]));
		sessions.order = chats.map((record) => record.id);
		sessions.chatListStatus = 'ready';
		const { container } = render(ChatBoardPanelTestHost, {
			controller,
			sessions,
			onOpenChat: vi.fn(),
		});
		const focused = await screen.findByRole('button', { name: 'Open Chat 5' });
		const card = focused.closest<HTMLElement>('[data-chat-board-occurrence]')!;
		focused.focus();

		sessions.order = [...sessions.order.filter((chatId) => chatId !== 'chat-5'), 'chat-5'];
		await tick();

		await waitFor(() => expect(document.activeElement).toBe(focused));
		expect(focused.isConnected).toBe(true);
		expect(container.contains(card)).toBe(true);
		expect(card.dataset.chatBoardOccurrenceIndex).toBe('99');

		screen.getByRole('button', { name: 'View' }).focus();
		await waitFor(() => expect(container.contains(card)).toBe(false));
	});
});
