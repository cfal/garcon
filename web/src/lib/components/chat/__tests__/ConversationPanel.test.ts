import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import { ConversationScrollController } from '$lib/chat/transcript/conversation-scroll-controller.svelte.js';
import type {
	ConversationPanelPresentationPort,
	ConversationPanelRegistration,
} from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import type { ConversationPanelRestoreTarget } from '$lib/chat/transcript/conversation-panel-restore-target.js';
import type { ConversationPanelActions } from '../conversation-panel-actions.js';
import type { ChatSessionRecord } from '$lib/types/chat-session.js';
import type { ChatQueueState } from '$lib/types/chat.js';
import type { GitQuickSummaryReady } from '$lib/api/git.js';
import * as m from '$lib/paraglide/messages.js';
import { UserMessage } from '$shared/chat-types';

const runtime = vi.hoisted(() => ({
	autoScrollToBottom: false,
	processing: true,
	reduceMotion: false,
	queue: null as ChatQueueState | null,
	summary: null as GitQuickSummaryReady | null,
}));

vi.mock('$lib/context', () => ({
	getAppShell: () => ({ isMobile: false }),
	getChatSessions: () => ({ isChatProcessing: () => runtime.processing }),
	getConversationUi: () => ({
		getExecutionControl: () => (runtime.queue ? { queue: runtime.queue } : null),
		pendingPermissionsFor: () => [],
	}),
	getGitBranchActions: () => ({
		currentProjectPath: '/project',
		lastError: null,
		refs: [],
		branchSort: { key: 'name', direction: 'asc' },
		showBranchDropdown: false,
		isLoadingBranches: false,
	}),
	getGitQuickSummary: () => ({
		summaryFor: () => runtime.summary,
		lastErrorFor: () => null,
		isRefreshingFor: () => false,
		canShowTrayFor: () => true,
	}),
	getLocalSettings: () => ({
		autoScrollToBottom: runtime.autoScrollToBottom,
		chatMaxWidth: 'default',
		reduceMotion: runtime.reduceMotion,
		showQuickCommitTray: true,
	}),
	getModelCatalog: () => ({ supportsSteering: () => true }),
	getOptionalTransientLayers: () => null,
}));

vi.mock('$lib/components/chat/ConversationFeed.svelte', async () => ({
	default: (await import('./ConversationPanelFeedStub.svelte')).default,
}));

import ConversationPanel from '../ConversationPanel.svelte';

function chat(): ChatSessionRecord {
	return {
		id: 'chat-1',
		parentChat: null,
		projectPath: '/project',
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
		isProcessing: runtime.processing,
		processingPhase: runtime.processing ? 'running' : null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: runtime.processing ? 'running' : 'draft',
		agentOwnershipEpoch: null,
		tags: [],
	};
}

function queue(): ChatQueueState {
	return {
		entries: [
			{
				id: 'queue-1',
				content: 'Queued input',
				revision: 1,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			},
		],
		steeringEntryId: null,
		recentlyDispatched: [],
		pause: null,
		reorderRevision: 0,
	};
}

function gitSummary(): GitQuickSummaryReady {
	return {
		status: 'ready',
		project: '/project',
		repoRoot: '/project',
		branch: 'main',
		hasCommits: true,
		changedFiles: 2,
		trackedChangedFiles: 1,
		untrackedFiles: 1,
		stagedFiles: 1,
		unstagedFiles: 1,
		additions: 3,
		deletions: 1,
		fingerprintVersion: 1,
		fingerprint: 'v1:test',
	};
}

function makePanel() {
	const transcript = new ActiveTranscriptState(new ChatTranscriptCache({ limit: 50 }));
	transcript.activateChat('chat-1');
	const lifecycle = new ConversationLifecycleState();
	lifecycle.beginTurn('chat-1');
	let presentation: ConversationPanelPresentationPort | null = null;
	let lastRestoreTarget: ConversationPanelRestoreTarget = { kind: 'end' };
	const scroll = new ConversationScrollController({
		getScrollContainer: () => presentation?.getScrollContainer() ?? null,
		getViewport: () => presentation?.getViewport() ?? null,
		getQueueContainer: () => presentation?.getQueueContainer(),
		chatState: transcript,
		getChatId: () => 'chat-1',
	});
	const prepareForInteractionLoss = vi.fn();
	const panel: ConversationPanelRegistration = {
		surfaceId: 'chat-view:window-panel-test',
		chatId: 'chat-1',
		transcript,
		lifecycle,
		scroll,
		attachPresentation: (port) => {
			presentation = port;
			return () => {
				if (presentation !== port) return;
				lastRestoreTarget = port.captureRestoreTarget() ?? lastRestoreTarget;
				presentation = null;
			};
		},
		captureRestoreTarget: () => {
			lastRestoreTarget = presentation?.captureRestoreTarget() ?? lastRestoreTarget;
			return lastRestoreTarget;
		},
		resumePendingRestore: () => {},
		prepareForInteractionLoss,
		prepareForHide: () => {
			lastRestoreTarget = presentation?.captureRestoreTarget() ?? lastRestoreTarget;
			return lastRestoreTarget;
		},
		restore: async () => {},
		destroy: () => {},
	};
	return { panel, prepareForInteractionLoss };
}

function makeActions(): ConversationPanelActions {
	return {
		reload: vi.fn(),
		decidePermission: vi.fn(),
		exitPlanMode: vi.fn(),
		fork: vi.fn(),
		appendToDraft: vi.fn(),
		generateTitle: vi.fn().mockResolvedValue(undefined),
		interruptQueue: vi.fn().mockResolvedValue(undefined),
		steerQueue: vi.fn().mockResolvedValue(undefined),
		pauseQueue: vi.fn().mockResolvedValue(undefined),
		resumeQueue: vi.fn().mockResolvedValue(undefined),
		reportQueueControlError: vi.fn(),
		editQueue: vi.fn(),
		openQueue: vi.fn(),
		deleteQueue: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		openCommit: vi.fn(),
		toggleBranch: vi.fn(),
		closeBranch: vi.fn(),
		createBranch: vi.fn(),
		switchBranch: vi.fn().mockResolvedValue(undefined),
		searchBranches: vi.fn(),
		sortBranches: vi.fn(),
		closeSwitchBranchDialog: vi.fn(),
	};
}

describe('ConversationPanel', () => {
	afterEach(() => {
		cleanup();
		runtime.autoScrollToBottom = false;
		runtime.processing = true;
		runtime.reduceMotion = false;
		runtime.queue = null;
		runtime.summary = null;
		vi.clearAllMocks();
	});

	it('leaves remount scroll restoration to the panel registry', async () => {
		runtime.autoScrollToBottom = true;
		const { panel } = makePanel();
		panel.transcript.replaceGeneration(
			'chat-1',
			'view-1',
			[
				{
					ordinal: 1,
					message: new UserMessage('2026-08-31T00:00:00.000Z', 'Existing message'),
				},
			],
			{
				lastOrdinal: 1,
				pageOldestOrdinal: 1,
				nextBeforeOrdinal: null,
				hasMore: false,
			},
		);
		const restoreLatest = vi.spyOn(panel.scroll, 'scrollToLatestAndFill');

		render(ConversationPanel, {
			surfaceId: panel.surfaceId,
			chat: chat(),
			panel,
			isCommandOwner: true,
			ownsComposer: true,
			actions: makeActions(),
		});
		await Promise.resolve();

		expect(restoreLatest).not.toHaveBeenCalled();
	});

	it('retains the feed restore target when the child presentation detaches first', async () => {
		const { panel } = makePanel();
		const rendered = render(ConversationPanel, {
			surfaceId: panel.surfaceId,
			chat: chat(),
			panel,
			isCommandOwner: true,
			ownsComposer: true,
			actions: makeActions(),
		});

		const detach = rendered.container.querySelector<HTMLButtonElement>('[data-detach-feed]');
		if (!detach) throw new Error('Expected feed detach control');
		await fireEvent.click(detach);

		expect(panel.prepareForHide()).toEqual({
			kind: 'row',
			transcriptViewId: 'view-1',
			ordinal: 1,
			viewportOffset: 12,
		});
	});

	it('composes the full feed, queue, status, paging, and fork controls without a composer', async () => {
		runtime.queue = queue();
		const { panel } = makePanel();
		const actions = makeActions();
		const { container } = render(ConversationPanel, {
			surfaceId: panel.surfaceId,
			chat: chat(),
			panel,
			isCommandOwner: true,
			ownsComposer: true,
			actions,
		});

		expect(container.querySelector('[data-conversation-feed-stub]')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Load earlier' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Load later' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Fork' })).toBeTruthy();
		expect(screen.getByText('Queued input')).toBeTruthy();
		expect(screen.getByRole('button', { name: m.chat_queue_pause() })).toBeTruthy();
		expect(screen.getByRole('button', { name: m.chat_loading_stop() })).toBeTruthy();
		expect(container.querySelector('[data-prompt-composer]')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_pause() }));
		expect(actions.pauseQueue).toHaveBeenCalledWith(panel.surfaceId, 'chat-1');
	});

	it('restores reduced-motion processing decoration on the detached status dock', () => {
		runtime.reduceMotion = true;
		const { panel } = makePanel();
		const { container } = render(ConversationPanel, {
			surfaceId: panel.surfaceId,
			chat: chat(),
			panel,
			isCommandOwner: true,
			ownsComposer: true,
			actions: makeActions(),
			composerInsetPx: 96,
		});

		const anchor = container.querySelector('[data-conversation-panel-status-anchor]');
		const spacer = container.querySelector('[data-conversation-panel-composer-spacer]');

		expect(anchor?.className).toContain('composer-thinking-active');
		expect(anchor?.className).toContain('composer-reduce-motion');
		expect(spacer?.getAttribute('style')).toContain('height: 96px');
		expect(
			container
				.querySelector('[data-slot="chat-processing-status"]')
				?.closest('.composer-thinking-active'),
		).toBe(anchor);
	});

	it('separates command ownership from composer inset and announcement ownership', async () => {
		runtime.queue = queue();
		const { panel, prepareForInteractionLoss } = makePanel();
		const actions = makeActions();
		const rendered = render(ConversationPanel, {
			surfaceId: panel.surfaceId,
			chat: chat(),
			panel,
			isCommandOwner: true,
			ownsComposer: true,
			actions,
			composerInsetPx: 96,
		});

		const root = rendered.container.querySelector('[data-conversation-panel]');
		const spacer = rendered.container.querySelector('[data-conversation-panel-composer-spacer]');
		expect(root?.getAttribute('data-conversation-panel-command-owner')).toBe('true');
		expect(root?.getAttribute('data-conversation-panel-composer-anchor')).toBe('true');
		expect(spacer?.getAttribute('style')).toContain('height: 96px');
		expect(
			rendered.container
				.querySelector('[data-announcements-enabled]')
				?.getAttribute('data-announcements-enabled'),
		).toBe('true');

		await rendered.rerender({
			surfaceId: panel.surfaceId,
			chat: chat(),
			panel,
			isCommandOwner: false,
			ownsComposer: true,
			actions,
			composerInsetPx: 96,
		});

		await waitFor(() => expect(prepareForInteractionLoss).toHaveBeenCalled());
		expect(root?.getAttribute('data-conversation-panel-command-owner')).toBeNull();
		expect(root?.getAttribute('data-conversation-panel-composer-anchor')).toBe('true');
		expect(spacer?.getAttribute('style')).toContain('height: 96px');
		expect(rendered.container.querySelector('[data-conversation-feed-stub]')).toBeTruthy();
		expect(screen.getByText('Queued input')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_pause() }));
		expect(actions.pauseQueue).toHaveBeenCalledWith(panel.surfaceId, 'chat-1');

		await rendered.rerender({
			surfaceId: panel.surfaceId,
			chat: chat(),
			panel,
			isCommandOwner: false,
			ownsComposer: false,
			actions,
			composerInsetPx: 96,
		});

		expect(root?.getAttribute('data-conversation-panel-composer-anchor')).toBeNull();
		expect(spacer?.getAttribute('style')).toContain('height: 0px');
		expect(
			rendered.container
				.querySelector('[data-announcements-enabled]')
				?.getAttribute('data-announcements-enabled'),
		).toBe('false');
		const status = rendered.container.querySelector('[data-slot="chat-processing-status"]');
		expect(status?.getAttribute('role')).toBeNull();
		expect(status?.getAttribute('aria-live')).toBe('off');
		expect(screen.getByRole('button', { name: m.chat_loading_stop() })).toBeTruthy();
	});

	it('renders the shared Git tray and routes its buttons through surface-qualified actions', async () => {
		runtime.processing = false;
		runtime.summary = gitSummary();
		const { panel } = makePanel();
		const actions = makeActions();
		render(ConversationPanel, {
			surfaceId: panel.surfaceId,
			chat: chat(),
			panel,
			isCommandOwner: true,
			ownsComposer: true,
			actions,
		});

		await fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
		expect(actions.openCommit).toHaveBeenCalledWith(panel.surfaceId, 'chat-1');
		await fireEvent.click(screen.getByRole('button', { name: /main/ }));
		expect(actions.toggleBranch).toHaveBeenCalledWith(panel.surfaceId, 'chat-1');
	});
});
