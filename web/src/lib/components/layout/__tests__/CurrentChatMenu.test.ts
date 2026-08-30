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
		effectiveProjectKey: '/workspace/project',
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

	it('renders mobile Git view commands before chat actions and invokes each callback', async () => {
		const openHistory = vi.fn();
		const openCompare = vi.fn();
		render(CurrentChatMenu, {
			...props(),
			onOpenGitHistory: openHistory,
			onOpenGitCompare: openCompare,
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
		expect(screen.queryByRole('menuitem', { name: m.workspace_fullscreen() })).toBeNull();
		await fireEvent.click(history);
		expect(openHistory).toHaveBeenCalledOnce();

		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_open_git_compare() }));
		expect(openCompare).toHaveBeenCalledOnce();
	});

	it('omits Git view commands when mobile callbacks are not supplied', async () => {
		render(CurrentChatMenu, { ...props(), isMobileLayout: false });
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_chat_more_actions() }));

		expect(screen.queryByRole('menuitem', { name: m.workspace_open_git_history() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.workspace_open_git_compare() })).toBeNull();
	});
});
