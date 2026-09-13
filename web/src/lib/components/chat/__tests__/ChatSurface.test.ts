import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
import type { SubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';
import * as m from '$lib/paraglide/messages.js';
import ChatSurface from '../ChatSurface.svelte';
import type { GhCapabilityStore } from '$lib/stores/gh-capability.svelte';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte';

const { sessions, ghCapability, workspace } = vi.hoisted(() => ({
	ghCapability: { available: true as boolean } satisfies Pick<GhCapabilityStore, 'available'>,
	workspace: { focusMobileSingleton: vi.fn(async () => {}) } satisfies Pick<
		WorkspaceCoordinator,
		'focusMobileSingleton'
	>,
	sessions: {
		selectedChat: null as ChatSessionRecord | null,
		isLoadingChats: false,
		setSelectedChatId: vi.fn(),
	},
}));

vi.mock('$lib/context', () => ({
	getChatSessions: () => sessions,
	getAppShell: () => ({ requestComposerFocus: vi.fn() }),
	getConversationPanels: () => ({ composerPanel: null }),
	getModelCatalog: () => ({
		supportsFork: () => true,
		supportsForkWhileRunning: () => false,
		supportsUpdateProjectPath: () => true,
	}),
	getOptionalTransientLayers: () => null,
	getWorkspaceCoordinator: () => workspace,
	getGhCapability: () => ghCapability,
	getGitViewLauncher: () => ({
		openHistory: vi.fn(),
		openCompare: vi.fn(),
	}),
}));

vi.mock('$lib/components/chat/ConversationWorkspace.svelte', async () => ({
	default: (await import('./ChatSurfaceConversationTestStub.svelte')).default,
}));

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
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		agentOwnershipEpoch: null,
		tags: [],
	};
}

function subagentModel(): SubagentManagementModel {
	return {
		entries: [
			{
				id: 'root',
				kind: 'root',
				name: 'Main chat',
				status: 'idle',
				statusLabel: 'Idle',
			},
			{
				id: 'research',
				kind: 'subagent',
				name: 'research',
				status: 'running',
				statusLabel: 'Running',
				anchorId: 'tool-input-research',
			},
		],
		subagents: [
			{
				id: 'research',
				kind: 'subagent',
				name: 'research',
				status: 'running',
				statusLabel: 'Running',
				anchorId: 'tool-input-research',
			},
		],
	};
}

function props(
	subagentToolbar: SubagentToolbarState,
	isMobile = true,
	isVisible = true,
	isInteractive = true,
) {
	return {
		isMobile,
		isVisible,
		isInteractive,
		subagentToolbar,
	};
}

describe('ChatSurface mobile toolbar', () => {
	afterEach(() => {
		cleanup();
		sessions.selectedChat = null;
		ghCapability.available = true;
		vi.clearAllMocks();
	});

	it('keeps workspace commands available without a selected chat', async () => {
		const rendered = render(ChatSurface, props(new SubagentToolbarState()));
		const conversation = rendered.container.querySelector('[data-conversation-workspace-layer]');
		expect(conversation?.classList.contains('invisible')).toBe(true);
		expect(conversation?.hasAttribute('inert')).toBe(true);
		expect(conversation?.getAttribute('aria-hidden')).toBe('true');
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
		expect(screen.queryByRole('menuitem', { name: m.share_button() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.sidebar_chats_details() })).toBeNull();
		expect(screen.getByRole('menuitem', { name: m.workspace_open_chat_map() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: m.workspace_open_pull_requests() })).toBeTruthy();
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_open_chat_canvas() }));
		expect(workspace.focusMobileSingleton).toHaveBeenCalledWith('chat-canvas');
	});

	it('keeps chat actions out of the empty toolbar while global selection catches up', async () => {
		sessions.selectedChat = chat();
		const subagentToolbar = new SubagentToolbarState();
		const rendered = render(ChatSurface, props(subagentToolbar, true, false));
		const conversation = screen.getByTestId('conversation-workspace-stub');

		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
		expect(screen.queryByRole('menuitem', { name: m.share_button() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.sidebar_chats_details() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.sidebar_tooltips_delete_chat() })).toBeNull();
		expect(screen.getByRole('menuitem', { name: m.workspace_open_chat_map() })).toBeTruthy();

		await rendered.rerender(props(subagentToolbar));
		expect(screen.getByRole('menuitem', { name: m.share_button() })).toBeTruthy();
		expect(screen.getByTestId('conversation-workspace-stub')).toBe(conversation);
	});

	it('keeps stale subagent controls out of the empty mobile toolbar', async () => {
		sessions.selectedChat = chat();
		const subagentToolbar = new SubagentToolbarState();
		subagentToolbar.register({ model: subagentModel(), jumpToTool: vi.fn() });
		const rendered = render(ChatSurface, props(subagentToolbar, true, false));

		expect(screen.queryByRole('button', { name: /Agents/ })).toBeNull();
		await rendered.rerender(props(subagentToolbar));
		expect(screen.getByRole('button', { name: /Agents/ })).toBeTruthy();
	});

	it.each([true, false])(
		'opens secondary views from the menu with GitHub available=%s',
		async (available) => {
			sessions.selectedChat = chat();
			ghCapability.available = available;
			render(ChatSurface, props(new SubagentToolbarState()));
			for (const [kind, label] of [
				['chat-map', m.workspace_open_chat_map()],
				['chat-canvas', m.workspace_open_chat_canvas()],
				['pull-requests', m.workspace_open_pull_requests()],
			] as const) {
				await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_settings() }));
				if (kind === 'pull-requests' && !available) {
					expect(screen.queryByRole('menuitem', { name: label })).toBeNull();
					continue;
				}
				await fireEvent.click(screen.getByRole('menuitem', { name: label }));
				expect(workspace.focusMobileSingleton).toHaveBeenLastCalledWith(kind);
			}
		},
	);

	it('keeps Agents at the start and current-chat actions at the end', async () => {
		sessions.selectedChat = chat();
		const subagentToolbar = new SubagentToolbarState();
		subagentToolbar.register({
			model: subagentModel(),
			jumpToTool: vi.fn(),
		});

		const rendered = render(ChatSurface, props(subagentToolbar));
		const toolbar = rendered.container.querySelector('[data-mobile-chat-toolbar]');
		const agents = screen.getByRole('button', { name: /Agents/ });
		const menu = screen.getByRole('button', { name: m.sidebar_actions_settings() });
		const menuRegion = rendered.container.querySelector('[data-mobile-current-chat-menu]');

		expect(toolbar).toBeTruthy();
		expect(toolbar?.classList.contains('sm:hidden')).toBe(false);
		expect(toolbar?.firstElementChild?.contains(agents)).toBe(true);
		expect(menuRegion?.contains(menu)).toBe(true);
		expect(
			screen.getByTestId('conversation-workspace-stub').getAttribute('data-reserve-mobile-toolbar'),
		).toBe('true');

		await rendered.rerender(props(subagentToolbar, false));
		expect(rendered.container.querySelector('[data-mobile-chat-toolbar]')).toBeNull();
	});

	it('keeps the menu end-aligned when there are no subagents', async () => {
		sessions.selectedChat = chat();
		const subagentToolbar = new SubagentToolbarState();
		const rendered = render(ChatSurface, props(subagentToolbar));

		expect(screen.queryByRole('button', { name: /Agents/ })).toBeNull();
		expect(
			rendered.container
				.querySelector('[data-mobile-current-chat-menu]')
				?.contains(screen.getByRole('button', { name: m.sidebar_actions_settings() })),
		).toBe(true);

		const unregister = subagentToolbar.register({
			model: subagentModel(),
			jumpToTool: vi.fn(),
		});
		expect(await screen.findByRole('button', { name: /Agents/ })).toBeTruthy();

		unregister();
		await waitFor(() => expect(screen.queryByRole('button', { name: /Agents/ })).toBeNull());
	});

	it('prepares row-owned transient UI before hiding the conversation layer', async () => {
		sessions.selectedChat = chat();
		const subagentToolbar = new SubagentToolbarState();
		const rendered = render(ChatSurface, props(subagentToolbar));
		const workspace = screen.getByTestId('conversation-workspace-stub');

		expect(workspace.getAttribute('data-prepare-hide-count')).toBe('0');
		await rendered.rerender(props(subagentToolbar, true, false));
		expect(workspace.getAttribute('data-prepare-hide-count')).toBe('1');
		expect(screen.getByTestId('conversation-workspace-stub')).toBe(workspace);
		const conversation = rendered.container.querySelector('[data-conversation-workspace-layer]');
		expect(conversation?.classList.contains('invisible')).toBe(true);
		expect(conversation?.hasAttribute('inert')).toBe(true);
		expect(conversation?.getAttribute('aria-hidden')).toBe('true');
	});

	it('keeps row-owned transient UI visible while a modal makes the chat inert', async () => {
		sessions.selectedChat = chat();
		const subagentToolbar = new SubagentToolbarState();
		const rendered = render(ChatSurface, props(subagentToolbar));
		const workspace = screen.getByTestId('conversation-workspace-stub');

		await rendered.rerender(props(subagentToolbar, true, true, false));

		expect(workspace.getAttribute('data-visible')).toBe('true');
		expect(workspace.getAttribute('data-prepare-hide-count')).toBe('0');
	});
});
