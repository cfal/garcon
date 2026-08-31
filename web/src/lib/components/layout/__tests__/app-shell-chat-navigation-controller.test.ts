import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import { AppShellChatNavigationController } from '../app-shell-chat-navigation-controller.svelte.js';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

function createHarness() {
	let routeChatId: string | undefined = 'chat-b';
	let selectedChatId: string | null = 'chat-b';
	let isLoadingChats = false;
	let currentWindowId = 'window-main' as WorkspaceWindowId;
	const chats = new Set(['chat-a', 'chat-b', 'chat-c']);
	const showChat = vi.fn<(chatId: string) => Promise<unknown>>(async () => undefined);
	const navigateToChat = vi.fn<(chatId: string) => Promise<void>>(async () => undefined);
	const navigateToBareRoute = vi.fn<() => Promise<void>>(async () => undefined);
	const requestComposerFocus = vi.fn();
	const reportOpenError = vi.fn();
	const reportDeleteError = vi.fn();
	const controller = new AppShellChatNavigationController({
		get routeChatId() {
			return routeChatId;
		},
		get selectedChatId() {
			return selectedChatId;
		},
		get isLoadingChats() {
			return isLoadingChats;
		},
		get currentWindowId() {
			return currentWindowId;
		},
		hasChat: (chatId) => chats.has(chatId),
		showChatInCurrentWindow: showChat,
		setSelectedChatId: (chatId) => {
			selectedChatId = chatId;
		},
		navigateToChat,
		navigateToBareRoute,
		requestComposerFocus,
		reportOpenError,
		reportDeleteError,
	});

	return {
		controller,
		chats,
		showChat,
		navigateToChat,
		navigateToBareRoute,
		requestComposerFocus,
		reportOpenError,
		reportDeleteError,
		get routeChatId() {
			return routeChatId;
		},
		get selectedChatId() {
			return selectedChatId;
		},
		setSelectedChatId(chatId: string | null) {
			selectedChatId = chatId;
		},
		setRouteChatId(chatId: string | undefined) {
			routeChatId = chatId;
		},
		setLoadingChats(loading: boolean) {
			isLoadingChats = loading;
		},
		setCurrentWindowId(windowId: WorkspaceWindowId) {
			currentWindowId = windowId;
		},
	};
}

describe('AppShellChatNavigationController', () => {
	it('consumes a focused-window route echo without placing it into a newly focused window', async () => {
		const harness = createHarness();
		const navigation = deferred<void>();
		harness.navigateToChat.mockImplementationOnce(() => navigation.promise);

		const synchronizing = harness.controller.synchronizeFocusedChat('chat-a');
		expect(harness.selectedChatId).toBe('chat-a');
		expect(harness.controller.pendingChatTarget).toBe('chat-a');

		navigation.resolve();
		await Promise.resolve();
		harness.setRouteChatId('chat-a');
		harness.controller.handleRouteChat('chat-a');
		expect(harness.showChat).not.toHaveBeenCalled();

		await synchronizing;
		expect(harness.controller.pendingChatTarget).toBeNull();
	});

	it('still places an external route target in the current window', async () => {
		const harness = createHarness();
		harness.controller.handleRouteChat('chat-a');

		expect(harness.showChat).toHaveBeenCalledWith('chat-a');
	});

	it('finishes the newest focused-window route last', async () => {
		const harness = createHarness();
		const firstNavigation = deferred<void>();
		harness.navigateToChat.mockImplementation(async (chatId) => {
			if (chatId === 'chat-a') await firstNavigation.promise;
			harness.setRouteChatId(chatId);
		});

		const first = harness.controller.synchronizeFocusedChat('chat-a');
		expect(harness.controller.pendingWindowId).toBe('window-main');
		await Promise.resolve();
		expect(harness.navigateToChat).toHaveBeenCalledOnce();

		harness.setCurrentWindowId('window-other');
		const second = harness.controller.synchronizeFocusedChat('chat-b');
		expect(harness.selectedChatId).toBe('chat-b');
		expect(harness.navigateToChat).toHaveBeenCalledTimes(1);

		firstNavigation.resolve();
		await Promise.all([first, second]);
		expect(harness.navigateToChat.mock.calls.map(([chatId]) => chatId)).toEqual([
			'chat-a',
			'chat-b',
		]);
		expect(harness.routeChatId).toBe('chat-b');
		expect(harness.selectedChatId).toBe('chat-b');
		expect(harness.requestComposerFocus).not.toHaveBeenCalled();
	});

	it('requests composer focus for explicit Chat placement', async () => {
		const harness = createHarness();

		await harness.controller.showChatInCurrentWindow('chat-a', { navigate: true });

		expect(harness.requestComposerFocus).toHaveBeenCalledOnce();
	});

	it('cancels pending Chat selection when the route becomes bare', async () => {
		const harness = createHarness();
		const placement = deferred<unknown>();
		harness.showChat.mockImplementationOnce(() => placement.promise);

		const selecting = harness.controller.showChatInCurrentWindow('chat-c', { navigate: true });
		harness.controller.handleRouteChat(null);
		expect(harness.selectedChatId).toBeNull();
		expect(harness.controller.pendingChatTarget).toBeNull();

		placement.resolve(undefined);
		await selecting;
		expect(harness.navigateToChat).not.toHaveBeenCalled();
		expect(harness.requestComposerFocus).not.toHaveBeenCalled();
	});

	it('does not select a chat deleted while its workspace placement is pending', async () => {
		const harness = createHarness();
		const placement = deferred<unknown>();
		harness.showChat.mockImplementationOnce(() => placement.promise);

		const selecting = harness.controller.showChatInCurrentWindow('chat-a', { navigate: true });
		harness.chats.delete('chat-a');
		placement.resolve(undefined);
		await selecting;

		expect(harness.selectedChatId).toBe('chat-b');
		expect(harness.navigateToChat).not.toHaveBeenCalled();
	});

	it('does not let deletion fallback replace a newer chat selection', async () => {
		const harness = createHarness();
		harness.setSelectedChatId('chat-a');
		const clearPresentation = deferred<void>();
		const newerPlacement = deferred<unknown>();
		harness.showChat.mockImplementation((chatId) =>
			chatId === 'chat-b' ? newerPlacement.promise : Promise.resolve(),
		);
		const deleting = harness.controller.reconcileDeletedChat({
			chatId: 'chat-a',
			wasSelected: true,
			neighborId: 'chat-c',
			removeLocal: () => {
				harness.chats.delete('chat-a');
				harness.setSelectedChatId(null);
			},
			clearPresentation: () => clearPresentation.promise,
		});

		const selecting = harness.controller.showChatInCurrentWindow('chat-b', { navigate: true });
		clearPresentation.resolve();
		await deleting;
		expect(harness.showChat).toHaveBeenCalledTimes(1);
		expect(harness.showChat).toHaveBeenCalledWith('chat-b');
		expect(harness.navigateToBareRoute).not.toHaveBeenCalled();

		newerPlacement.resolve(undefined);
		await selecting;
		expect(harness.selectedChatId).toBe('chat-b');
	});

	it('reports presentation cleanup failure and still exits a deleted selected chat route', async () => {
		const harness = createHarness();
		harness.setSelectedChatId('chat-a');
		const error = new Error('Failed to clear deleted chat');

		await harness.controller.reconcileDeletedChat({
			chatId: 'chat-a',
			wasSelected: true,
			neighborId: null,
			removeLocal: () => {
				harness.chats.delete('chat-a');
				harness.setSelectedChatId(null);
			},
			clearPresentation: () => Promise.reject(error),
		});

		expect(harness.reportDeleteError).toHaveBeenCalledWith(error);
		expect(harness.navigateToBareRoute).toHaveBeenCalledOnce();
		expect(harness.selectedChatId).toBeNull();
	});
});
