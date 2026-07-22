import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';
import CurrentChatMenu from '../CurrentChatMenu.svelte';

function chat(): ChatSessionRecord {
	return {
		id: 'chat-1',
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
		isUnread: false,
		status: 'draft',
		tags: [],
	};
}

function props(onOpenUserMessageNavigator?: () => void) {
	return {
		selectedChat: chat(),
		isMobileLayout: true,
		splitEnabled: false,
		canToggleSplitView: true,
		isDesktopFullscreen: false,
		canToggleDesktopFullscreen: false,
		canReload: true,
		canUpdateProjectPath: true,
		canFork: true,
		canForkNow: true,
		onToggleSplitMode: vi.fn(),
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
});
