import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AppShellBreakpointWorkspace,
	AppShellLocalSettingsState,
} from './AppShellBreakpointWorkspace.svelte.js';
import { reduceWorkspaceLayout } from '$lib/workspace/workspace-layout.svelte.js';
import { portableSingletonDescriptor } from '$lib/workspace/surface-types.js';
import { HOVER_CAPABLE_MEDIA_QUERY } from '$lib/layout/desktop-layout.js';

const testContext = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const chatNavigation = vi.hoisted(() => ({
	gotoChat: vi.fn<(_chatId: string) => Promise<void>>(() => Promise.resolve()),
}));
const chatDraftContext = vi.hoisted(() => ({
	set: vi.fn<(_drafts: unknown) => void>(),
}));

vi.mock('$lib/chat/actions/chat-navigation.js', () => ({
	gotoChat: chatNavigation.gotoChat,
}));

vi.mock('$lib/context', () => ({
	getAppShell: () => testContext.current?.appShell,
	getChatSessions: () => testContext.current?.sessions,
	getGhCapability: () => testContext.current?.ghCapability,
	getLocalSettings: () => testContext.current?.localSettings,
	getNavigation: () => testContext.current?.navigation,
	getNotifications: () => testContext.current?.notifications,
	getSidebarProjectCollapse: () => testContext.current?.projectCollapse,
	getSidebarSearch: () => testContext.current?.sidebarSearch,
	getTerminalRegistry: () => testContext.current?.terminals,
	getWorkspaceCoordinator: () => testContext.current?.workspace,
	getWs: () => testContext.current?.ws,
	setChatDrafts: chatDraftContext.set,
}));

vi.mock('$lib/components/workspace/WorkspaceRoot.svelte', async () => ({
	default: (await import('./AppShellWorkspaceRootStub.svelte')).default,
}));
vi.mock('../../sidebar/Sidebar.svelte', async () => ({
	default: (await import('./AppShellSidebarStub.svelte')).default,
}));
vi.mock('../ResizeHandle.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('$lib/components/workspace/BottomTabBar.svelte', async () => ({
	default: (await import('./AppShellBottomTabBarStub.svelte')).default,
}));
vi.mock('$lib/components/shared/NotificationHost.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('../../chat/NewChatDialog.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('../../files/FileDialogHost.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('../../files/FileDirtyUnloadGuard.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('$lib/components/workspace/WorkspaceCloseGuard.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('$lib/components/chat/ChatActionDialogs.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('$lib/components/chat/ChatProjectPathDialog.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('$lib/components/chat/ShareChatDialog.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));
vi.mock('$lib/components/sidebar/SidebarTagDialog.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
}));

const AppShell = (await import('../AppShell.svelte')).default;

class TestMediaQueryList {
	readonly media: string;
	onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;
	matches: boolean;
	readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

	constructor(media: string, matches = false) {
		this.media = media;
		this.matches = matches;
	}

	addEventListener(
		_type: 'change',
		listener: (this: MediaQueryList, event: MediaQueryListEvent) => unknown,
	): void {
		this.listeners.add(listener);
	}

	removeEventListener(
		_type: 'change',
		listener: (this: MediaQueryList, event: MediaQueryListEvent) => unknown,
	): void {
		this.listeners.delete(listener);
	}

	addListener(listener: (this: MediaQueryList, event: MediaQueryListEvent) => unknown): void {
		this.listeners.add(listener);
	}

	removeListener(listener: (this: MediaQueryList, event: MediaQueryListEvent) => unknown): void {
		this.listeners.delete(listener);
	}

	dispatchEvent(event: Event): boolean {
		const mediaQuery = this as unknown as MediaQueryList;
		for (const listener of this.listeners) listener.call(mediaQuery, event as MediaQueryListEvent);
		this.onchange?.call(mediaQuery, event as MediaQueryListEvent);
		return !event.defaultPrevented;
	}

	setMatches(matches: boolean): void {
		this.matches = matches;
		const event = new Event('change');
		Object.defineProperties(event, {
			matches: { value: matches },
			media: { value: this.media },
		});
		this.dispatchEvent(event as MediaQueryListEvent);
	}
}

function installContext(): AppShellBreakpointWorkspace {
	const workspace = new AppShellBreakpointWorkspace();
	const noOpSubscription = () => () => undefined;
	let selectedChatId: string | null = null;
	const sessions = {
		orderedChats: [],
		get selectedChatId() {
			return selectedChatId;
		},
		selectedChat: null,
		lastSelectedChatId: null,
		isLoadingChats: false,
		order: [],
		byId: {},
		setSelectedChatId: vi.fn((chatId: string | null) => {
			selectedChatId = chatId;
		}),
		rememberSelectedChat: vi.fn(),
		refreshChats: vi.fn(async () => undefined),
		quietRefreshChats: vi.fn(async () => undefined),
		upsertServerChat: vi.fn(),
		hasChat: vi.fn((chatId: string) => chatId === 'chat-test'),
		removeChat: vi.fn(),
		deleteRemoteChat: vi.fn(async () => undefined),
		renameChat: vi.fn(async () => undefined),
		patchChat: vi.fn(),
	};
	testContext.current = {
		workspace,
		navigation: {
			onNavigateChatAboveRequested: noOpSubscription,
			onNavigateChatBelowRequested: noOpSubscription,
		},
		sessions,
		appShell: {
			sidebarOpen: false,
			keyboardHeight: 0,
			showSettings: false,
			showScheduledPrompts: false,
			showSnippets: false,
			projectBasePath: '',
			setSidebarOpen: vi.fn(),
			openNewChatDialog: vi.fn(),
			requestComposerFocus: vi.fn(),
			requestSidebarRecenterToSelected: vi.fn(),
			openScheduledPrompts: vi.fn(),
			openSettings: vi.fn(),
			onNewChatRequested: noOpSubscription,
			onRenameSelectedChatRequested: noOpSubscription,
			onDeleteSelectedChatRequested: noOpSubscription,
		},
		ws: {
			isConnected: false,
			connectionStatus: {
				phase: 'idle',
				episodeId: 0,
				reconnectAttempt: 0,
				lastConnectedAt: null,
			},
		},
		localSettings: new AppShellLocalSettingsState(),
		terminals: { orderedSessions: [] },
		notifications: {
			error: vi.fn(),
			info: vi.fn(),
			hasKey: vi.fn(() => false),
			dismissKey: vi.fn(),
		},
		sidebarSearch: { filteredChats: [], allKnownTags: [] },
		projectCollapse: { collapsedProjectKeys: new Set<string>() },
		ghCapability: { available: true },
	};
	return workspace;
}

describe('AppShell responsive workspace binding', () => {
	let breakpointMediaQuery: TestMediaQueryList;
	let hoverMediaQuery: TestMediaQueryList;

	beforeEach(() => {
		breakpointMediaQuery = new TestMediaQueryList('(max-width: 768px)');
		hoverMediaQuery = new TestMediaQueryList(HOVER_CAPABLE_MEDIA_QUERY, true);
		vi.stubGlobal(
			'matchMedia',
			vi.fn((query: string) => {
				if (query === breakpointMediaQuery.media) return breakpointMediaQuery;
				if (query === hoverMediaQuery.media) return hoverMediaQuery;
				throw new Error(`Unexpected media query: ${query}`);
			}),
		);
	});

	afterEach(() => {
		cleanup();
		testContext.current = null;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		chatNavigation.gotoChat.mockReset();
		chatNavigation.gotoChat.mockResolvedValue(undefined);
		chatDraftContext.set.mockReset();
	});

	it('provides one shared draft store for the shell lifetime', () => {
		installContext();
		const view = render(AppShell);

		expect(chatDraftContext.set).toHaveBeenCalledOnce();
		const drafts = chatDraftContext.set.mock.calls[0]?.[0] as { destroy(): void };
		const destroy = vi.spyOn(drafts, 'destroy');

		view.unmount();
		expect(destroy).toHaveBeenCalledOnce();
	});

	it('hands desktop and mobile breakpoint changes to the workspace coordinator', async () => {
		const workspace = installContext();
		render(AppShell);

		await waitFor(() => expect(workspace.exitCalls).toBe(1));
		expect(screen.getByTestId('workspace-root-stub').getAttribute('data-mobile')).toBe('false');

		breakpointMediaQuery.setMatches(true);
		await waitFor(() => expect(workspace.enterCalls).toBe(1));
		expect(screen.getByTestId('workspace-root-stub').getAttribute('data-mobile')).toBe('true');

		breakpointMediaQuery.setMatches(false);
		await waitFor(() => expect(workspace.exitCalls).toBe(2));
		expect(screen.getByTestId('workspace-root-stub').getAttribute('data-mobile')).toBe('false');
	});

	it('reconciles breakpoint changes from resize when the media query omits change events', async () => {
		const workspace = installContext();
		render(AppShell);

		await waitFor(() => expect(workspace.exitCalls).toBe(1));
		breakpointMediaQuery.matches = true;
		window.dispatchEvent(new Event('resize'));
		await waitFor(() => expect(workspace.enterCalls).toBe(1));

		breakpointMediaQuery.matches = false;
		window.dispatchEvent(new Event('resize'));
		await waitFor(() => expect(workspace.exitCalls).toBe(2));
	});

	it('loads the initial chat list independently of WebSocket connection state', async () => {
		installContext();
		const sessions = testContext.current?.sessions as {
			refreshChats: ReturnType<typeof vi.fn>;
		};

		render(AppShell);

		await waitFor(() => expect(sessions.refreshChats).toHaveBeenCalledOnce());
	});

	it('uses the shared backdrop for the mobile drawer and preserves dismissal', async () => {
		const workspace = installContext();
		const appShell = testContext.current?.appShell as {
			sidebarOpen: boolean;
			setSidebarOpen: ReturnType<typeof vi.fn>;
		};
		appShell.sidebarOpen = true;
		breakpointMediaQuery.matches = true;
		render(AppShell);

		await waitFor(() => expect(workspace.enterCalls).toBe(1));
		const backdrop = screen.getByRole('button', { name: 'Hide sidebar' });
		expect(backdrop.classList.contains('transient-backdrop')).toBe(true);

		await fireEvent.click(backdrop);
		expect(appShell.setSidebarOpen).toHaveBeenCalledWith(false);
	});

	it('does not render the mobile drawer backdrop on desktop', async () => {
		const workspace = installContext();
		const appShell = testContext.current?.appShell as { sidebarOpen: boolean };
		appShell.sidebarOpen = true;
		render(AppShell);

		await waitFor(() => expect(workspace.exitCalls).toBe(1));
		expect(screen.queryByRole('button', { name: 'Hide sidebar' })).toBeNull();
	});

	it('keeps chat selection, routing, Chat presentation, and composer focus in AppShell', async () => {
		const workspace = installContext();
		const sessions = testContext.current?.sessions as {
			setSelectedChatId: ReturnType<typeof vi.fn>;
		};
		const appShell = testContext.current?.appShell as {
			requestComposerFocus: ReturnType<typeof vi.fn>;
		};
		render(AppShell);

		await fireEvent.click(screen.getByRole('button', { name: 'Select test chat' }));

		expect(sessions.setSelectedChatId).toHaveBeenCalledWith('chat-test');
		expect(chatNavigation.gotoChat).toHaveBeenCalledWith('chat-test');
		expect(workspace.showChatCalls).toBe(1);
		await waitFor(() => expect(appShell.requestComposerFocus).toHaveBeenCalledOnce());
		expect(chatNavigation.gotoChat).toHaveBeenCalledOnce();
	});

	it.each(['git', 'git-history', 'git-compare'] as const)(
		'hides the desktop chat list when %s is active and the Git setting is enabled',
		async (kind) => {
			const workspace = installContext();
			(
				testContext.current?.localSettings as { hideChatListWhenGitFocused: boolean }
			).hideChatListWhenGitFocused = true;
			const surfaceId = `singleton:${kind}`;
			if (!workspace.layout.surface(surfaceId)) {
				const registered = reduceWorkspaceLayout(workspace.layout.snapshot, [
					{
						type: 'register-surface',
						surface: portableSingletonDescriptor(kind),
						windowId: 'window-main',
					},
				]);
				workspace.layout.publish(workspace.layout.revision, registered);
			}
			const focused = reduceWorkspaceLayout(workspace.layout.snapshot, [
				{ type: 'activate-window-tab', windowId: 'window-main', surfaceId },
			]);
			workspace.layout.publish(workspace.layout.revision, focused);

			render(AppShell);
			await waitFor(() =>
				expect(
					document.querySelector('[data-workspace-chat-list]')?.getAttribute('aria-hidden'),
				).toBe('true'),
			);
		},
	);

	it('reorders one mounted desktop chat list when its dock side changes', async () => {
		installContext();
		render(AppShell);
		const localSettings = testContext.current?.localSettings as AppShellLocalSettingsState;
		const chatList = document.querySelector<HTMLElement>('[data-workspace-chat-list]');
		const sidebarButton = screen.getByRole('button', { name: 'Select test chat' });
		expect(chatList?.classList.contains('order-first')).toBe(true);

		localSettings.chatListDock = 'right';

		await waitFor(() => expect(chatList?.classList.contains('order-last')).toBe(true));
		expect(document.querySelector('[data-workspace-chat-list]')).toBe(chatList);
		expect(screen.getByRole('button', { name: 'Select test chat' })).toBe(sidebarButton);
	});

	it('reveals and collapses an autohidden chat sidebar without moving workspace content', async () => {
		installContext();
		const localSettings = testContext.current?.localSettings as AppShellLocalSettingsState;
		localSettings.chatListAutohide = true;
		render(AppShell);

		const chatList = document.querySelector<HTMLElement>('[data-workspace-chat-list]');
		const panel = document.querySelector<HTMLElement>('[data-workspace-chat-list-panel]');
		const workspaceContent = document.querySelector<HTMLElement>('[data-workspace-content]');
		const revealTrigger = screen.getByRole('button', { name: 'Show chat sidebar' });
		expect(chatList?.style.width).toBe('0px');
		expect(panel?.getAttribute('aria-hidden')).toBe('true');
		expect(panel?.hasAttribute('inert')).toBe(true);

		await fireEvent.pointerEnter(chatList as HTMLElement);
		await waitFor(() => expect(panel?.getAttribute('aria-hidden')).toBe('false'));
		expect(panel?.hasAttribute('inert')).toBe(false);
		expect(chatList?.style.width).toBe('0px');

		const sidebarButton = screen.getByRole('button', { name: 'Select test chat' });
		sidebarButton.focus();
		await fireEvent.pointerEnter(workspaceContent as HTMLElement);
		expect(panel?.getAttribute('aria-hidden')).toBe('false');

		await fireEvent.keyDown(sidebarButton, { key: 'Escape' });
		await waitFor(() => expect(panel?.getAttribute('aria-hidden')).toBe('true'));
		expect(document.activeElement).toBe(revealTrigger);

		await fireEvent.click(revealTrigger);
		await waitFor(() => expect(panel?.getAttribute('aria-hidden')).toBe('false'));
		revealTrigger.blur();
		await fireEvent.pointerEnter(workspaceContent as HTMLElement);
		await waitFor(() => expect(panel?.getAttribute('aria-hidden')).toBe('true'));

		hoverMediaQuery.setMatches(false);
		await waitFor(() => expect(panel?.getAttribute('aria-hidden')).toBe('false'));
		expect(screen.queryByRole('button', { name: 'Show chat sidebar' })).toBeNull();
		expect(chatList?.style.width).toBe('320px');
	});

	it.each([
		{ dock: 'left' as const, edgeClass: 'start-0', hiddenClass: '-translate-x-full' },
		{ dock: 'right' as const, edgeClass: 'end-0', hiddenClass: 'translate-x-full' },
	])(
		'places the autohide trigger and hidden panel on the $dock edge',
		({ dock, edgeClass, hiddenClass }) => {
			installContext();
			const localSettings = testContext.current?.localSettings as AppShellLocalSettingsState;
			localSettings.chatListAutohide = true;
			localSettings.chatListDock = dock;
			render(AppShell);

			const trigger = screen.getByRole('button', { name: 'Show chat sidebar' });
			const panel = document.querySelector<HTMLElement>('[data-workspace-chat-list-panel]');
			expect(trigger.classList.contains(edgeClass)).toBe(true);
			expect(panel?.classList.contains(hiddenClass)).toBe(true);
		},
	);

	it('hides and restores the desktop chat list for window fullscreen', async () => {
		const workspace = installContext();
		await workspace.enterWindowFullscreen('window-main');
		render(AppShell);

		await waitFor(() =>
			expect(
				document.querySelector('[data-workspace-chat-list]')?.getAttribute('aria-hidden'),
			).toBe('true'),
		);

		await workspace.exitWindowFullscreen('window-main');
		await waitFor(() =>
			expect(
				document.querySelector('[data-workspace-chat-list]')?.getAttribute('aria-hidden'),
			).toBe('false'),
		);
	});

	it.each(['commit', 'files', 'pull-requests'] as const)(
		'keeps the desktop chat list visible when %s is active',
		async (kind) => {
			const workspace = installContext();
			(
				testContext.current?.localSettings as { hideChatListWhenGitFocused: boolean }
			).hideChatListWhenGitFocused = true;
			const surfaceId = `singleton:${kind}`;
			if (!workspace.layout.surface(surfaceId)) {
				const registered = reduceWorkspaceLayout(workspace.layout.snapshot, [
					{
						type: 'register-surface',
						surface: portableSingletonDescriptor(kind),
						windowId: 'window-main',
					},
				]);
				workspace.layout.publish(workspace.layout.revision, registered);
			}
			const focused = reduceWorkspaceLayout(workspace.layout.snapshot, [
				{ type: 'activate-window-tab', windowId: 'window-main', surfaceId },
			]);
			workspace.layout.publish(workspace.layout.revision, focused);

			render(AppShell);
			await waitFor(() =>
				expect(
					document.querySelector('[data-workspace-chat-list]')?.getAttribute('aria-hidden'),
				).toBe('false'),
			);
		},
	);

	it.each(['git-history', 'git-compare'] as const)(
		'hides the mobile bottom bar for transient %s',
		async (kind) => {
			const workspace = installContext();
			const surfaceId = `singleton:${kind}`;
			const mobile = reduceWorkspaceLayout(workspace.layout.snapshot, [
				{
					type: 'register-surface',
					surface: portableSingletonDescriptor(kind),
				},
				{
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack: [],
				},
			]);
			workspace.layout.publish(workspace.layout.revision, mobile);
			workspace.isMobile = true;
			breakpointMediaQuery.matches = true;

			render(AppShell);
			expect(screen.queryByTestId('bottom-tab-bar-stub')).toBeNull();
		},
	);
});
