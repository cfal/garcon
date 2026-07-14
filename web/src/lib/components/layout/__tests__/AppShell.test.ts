import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShellBreakpointWorkspace } from './AppShellBreakpointWorkspace.svelte.js';

const testContext = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const chatNavigation = vi.hoisted(() => ({
	gotoChat: vi.fn<(_chatId: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('$lib/chat/chat-navigation', () => ({
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
	getWorkspaceCoordinator: () => testContext.current?.workspace,
	getWs: () => testContext.current?.ws,
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
vi.mock('../BottomTabBar.svelte', async () => ({
	default: (await import('./AppShellGenericStub.svelte')).default,
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
	readonly media = '(max-width: 768px)';
	onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;
	matches = false;
	readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

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
	testContext.current = {
		workspace,
		navigation: {
			onNavigateChatAboveRequested: noOpSubscription,
			onNavigateChatBelowRequested: noOpSubscription,
		},
		sessions: {
			orderedChats: [],
			selectedChatId: null,
			selectedChat: null,
			lastSelectedChatId: null,
			isLoadingChats: false,
			order: [],
			byId: {},
			setSelectedChatId: vi.fn(),
			rememberSelectedChat: vi.fn(),
			refreshChats: vi.fn(async () => undefined),
			quietRefreshChats: vi.fn(async () => undefined),
			refreshChatsAndReconcileProcessing: vi.fn(async () => undefined),
			upsertServerChat: vi.fn(),
			hasChat: vi.fn(() => false),
			removeChat: vi.fn(),
			deleteRemoteChat: vi.fn(async () => undefined),
			renameChat: vi.fn(async () => undefined),
			patchChat: vi.fn(),
		},
		appShell: {
			sidebarOpen: false,
			keyboardHeight: 0,
			showSettings: false,
			showScheduledPrompts: false,
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
		localSettings: {
			hideChatListWhenGitInMain: false,
			sidebarWidth: 320,
			sidebarGroupByProject: false,
			sidebarGroupNestedProjectPaths: false,
			set: vi.fn(),
		},
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
	let mediaQuery: TestMediaQueryList;

	beforeEach(() => {
		mediaQuery = new TestMediaQueryList();
		vi.stubGlobal(
			'matchMedia',
			vi.fn(() => mediaQuery),
		);
	});

	afterEach(() => {
		cleanup();
		testContext.current = null;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		chatNavigation.gotoChat.mockReset();
		chatNavigation.gotoChat.mockResolvedValue(undefined);
	});

	it('hands desktop and mobile breakpoint changes to the workspace coordinator', async () => {
		const workspace = installContext();
		render(AppShell);

		await waitFor(() => expect(workspace.exitCalls).toBe(1));
		expect(screen.getByTestId('workspace-root-stub').getAttribute('data-mobile')).toBe('false');

		mediaQuery.setMatches(true);
		await waitFor(() => expect(workspace.enterCalls).toBe(1));
		expect(screen.getByTestId('workspace-root-stub').getAttribute('data-mobile')).toBe('true');

		mediaQuery.setMatches(false);
		await waitFor(() => expect(workspace.exitCalls).toBe(2));
		expect(screen.getByTestId('workspace-root-stub').getAttribute('data-mobile')).toBe('false');
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
		expect(workspace.focusChatCalls).toBe(1);
		await waitFor(() => expect(appShell.requestComposerFocus).toHaveBeenCalledOnce());
	});
});
