import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';
import CurrentChatMenu from '../CurrentChatMenu.svelte';

function chat(): ChatSessionRecord {
	return {
		id: 'chat-1',
		parentChat: null,
		projectPath: '/workspace/project',
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
		canReloadFromNativeHistory: false,
		isUnread: false,
		status: 'draft',
		agentOwnershipEpoch: null,
		tags: [],
	};
}

function props(onOpenUserMessageNavigator?: () => void) {
	return {
		selectedChat: chat(),
		isMobileLayout: true,
		canReload: true,
		canUpdateProjectPath: true,
		canFork: true,
		canForkNow: true,
		onRename: vi.fn(),
		onDetails: vi.fn(),
		onReload: vi.fn(),
		onShare: vi.fn(),
		onProjectPath: vi.fn(),
		onFork: vi.fn(),
		onDelete: vi.fn(),
		onOpenUserMessageNavigator,
	};
}

describe('CurrentChatMenu', () => {
	afterEach(() => {
		cleanup();
		document.body.innerHTML = '';
	});

	it('uses the vertical actions icon on mobile and desktop', async () => {
		const rendered = render(CurrentChatMenu, props());
		const mobileTrigger = screen.getByRole('button', { name: m.sidebar_actions_settings() });

		expect(mobileTrigger.querySelector('.lucide-ellipsis-vertical')).toBeTruthy();
		expect(mobileTrigger.querySelector('.lucide-settings')).toBeNull();

		await rendered.rerender({ ...props(), isMobileLayout: false });
		const desktopTrigger = screen.getByRole('button', {
			name: m.sidebar_chat_more_actions(),
		});
		expect(desktopTrigger.querySelector('.lucide-ellipsis-vertical')).toBeTruthy();
	});

	it('omits the navigator action until its command is registered', async () => {
		render(CurrentChatMenu, props());

		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));

		expect(
			screen.queryByRole('menuitem', { name: m.chat_user_message_navigator_menu() }),
		).toBeNull();
	});

	it('invokes the shared navigator command from the mobile current-chat menu', async () => {
		const openNavigator = vi.fn();
		render(CurrentChatMenu, props(openNavigator));
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
		const navigatorItem = screen.getByRole('menuitem', {
			name: m.chat_user_message_navigator_menu(),
		});
		const items = screen.getAllByRole('menuitem');

		expect(items.indexOf(navigatorItem)).toBeLessThan(
			items.indexOf(screen.getByRole('menuitem', { name: m.share_button() })),
		);
		await fireEvent.click(navigatorItem);

		expect(openNavigator).toHaveBeenCalledOnce();
	});

	it('renders mobile workspace commands before chat actions and invokes each callback', async () => {
		const openHistory = vi.fn();
		const openCompare = vi.fn();
		const openTickets = vi.fn();
		const openChatMap = vi.fn();
		const openCanvas = vi.fn();
		const openPullRequests = vi.fn();
		render(CurrentChatMenu, {
			...props(),
			onOpenGitHistory: openHistory,
			onOpenGitCompare: openCompare,
			onOpenTickets: openTickets,
			onOpenChatMap: openChatMap,
			onOpenCanvas: openCanvas,
			onOpenPullRequests: openPullRequests,
		});
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
		const history = screen.getByRole('menuitem', {
			name: m.workspace_open_git_history(),
		});
		const compare = screen.getByRole('menuitem', {
			name: m.workspace_open_git_compare(),
		});
		const share = screen.getByRole('menuitem', { name: m.share_button() });
		const items = screen.getAllByRole('menuitem');

		expect(items.indexOf(history)).toBeLessThan(items.indexOf(compare));
		expect(items.indexOf(compare)).toBeLessThan(items.indexOf(share));
		const tickets = screen.getByRole('menuitem', { name: m.workspace_open_tickets() });
		expect(items.indexOf(tickets)).toBe(items.indexOf(compare) + 1);
		for (const label of [
			m.workspace_open_chat_map(),
			m.workspace_open_chat_canvas(),
			m.workspace_open_pull_requests(),
		]) {
			expect(items.indexOf(screen.getByRole('menuitem', { name: label }))).toBeLessThan(
				items.indexOf(share),
			);
		}
		expect(screen.queryByRole('menuitem', { name: m.workspace_fullscreen() })).toBeNull();
		await fireEvent.click(history);
		expect(openHistory).toHaveBeenCalledOnce();

		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_open_git_compare() }));
		expect(openCompare).toHaveBeenCalledOnce();
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_open_tickets() }));
		expect(openTickets).toHaveBeenCalledOnce();
		for (const [label, callback] of [
			[m.workspace_open_chat_map(), openChatMap],
			[m.workspace_open_chat_canvas(), openCanvas],
			[m.workspace_open_pull_requests(), openPullRequests],
		] as const) {
			await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
			await fireEvent.click(screen.getByRole('menuitem', { name: label }));
			expect(callback).toHaveBeenCalledOnce();
		}
	});

	it('omits Git view commands when mobile callbacks are not supplied', async () => {
		render(CurrentChatMenu, { ...props(), isMobileLayout: false });
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_chat_more_actions() }));

		expect(screen.queryByRole('menuitem', { name: m.workspace_open_git_history() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.workspace_open_git_compare() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.workspace_open_tickets() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.workspace_open_chat_map() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.workspace_open_chat_canvas() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.workspace_open_pull_requests() })).toBeNull();
	});

	it.each([
		{ hasChat: false, hasWorkspaceCommands: false, separators: 0 },
		{ hasChat: false, hasWorkspaceCommands: true, separators: 0 },
		{ hasChat: true, hasWorkspaceCommands: false, separators: 1 },
		{ hasChat: true, hasWorkspaceCommands: true, separators: 2 },
	])(
		'renders $separators separators with chat=$hasChat and workspace commands=$hasWorkspaceCommands',
		async ({ hasChat, hasWorkspaceCommands, separators }) => {
			render(CurrentChatMenu, {
				...props(),
				selectedChat: hasChat ? chat() : null,
				onOpenChatMap: hasWorkspaceCommands ? vi.fn() : undefined,
			});
			await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
			expect(
				screen.getByRole('menu').querySelectorAll('[data-slot="dropdown-menu-separator"]'),
			).toHaveLength(separators);
		},
	);
});
