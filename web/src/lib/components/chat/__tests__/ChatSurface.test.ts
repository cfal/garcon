import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
import type { SubagentManagementModel } from '$lib/chat/transcript/subagent-management.js';
import * as m from '$lib/paraglide/messages.js';
import ChatSurface from '../ChatSurface.svelte';

const { sessions, splitLayout } = vi.hoisted(() => ({
	sessions: {
		selectedChat: null as ChatSessionRecord | null,
		isLoadingChats: false,
		setSelectedChatId: vi.fn(),
	},
	splitLayout: {
		isEnabled: false,
		root: null,
		panes: [],
		paneCount: 0,
		focusedPaneId: null,
		focusedChatId: null,
		draggedChatId: null,
		draggedPaneId: null,
		focusPane: vi.fn(),
		closePane: vi.fn(),
		disable: vi.fn(),
		setRatioByPath: vi.fn(),
		swapPanes: vi.fn(),
		endDrag: vi.fn(),
		addChatToZone: vi.fn(),
		replacePaneChat: vi.fn(),
	},
}));

vi.mock('$lib/context', () => ({
	getChatSessions: () => sessions,
	getAppShell: () => ({ requestComposerFocus: vi.fn() }),
	getModelCatalog: () => ({
		supportsFork: () => true,
		supportsUpdateProjectPath: () => true,
	}),
	getSplitLayout: () => splitLayout,
	getChatInteractionGate: () => ({
		isChatDropEligible: false,
		register: () => () => {},
	}),
	getOptionalTransientLayers: () => null,
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
		processingRetry: null,
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

function props(subagentToolbar: SubagentToolbarState, isMobile = true, isVisible = true) {
	return {
		isMobile,
		reserveTopFloatingToolbar: false,
		isVisible,
		isInteractive: true,
		subagentToolbar,
	};
}

describe('ChatSurface mobile toolbar', () => {
	afterEach(() => {
		cleanup();
		sessions.selectedChat = null;
		vi.clearAllMocks();
	});

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
			screen
				.getByTestId('conversation-workspace-stub')
				.getAttribute('data-reserve-top-floating-toolbar'),
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
	});
});
