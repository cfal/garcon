import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import type { QueueEntry } from '$lib/types/chat.js';
import type { ConversationSessionController } from '$lib/chat/conversation/conversation-session-controller.svelte.js';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { ConversationBranchController } from './conversation-branch-controller.js';
import type {
	getChatSessions, getConversationPanels, getModelCatalog, getGitBranchActions,
	getWorkspaceCoordinator, getAppShell,
} from '$lib/context';
import { StaleConversationSurfaceError, type ConversationPanelActions } from './conversation-panel-actions.js';

interface PanelActionOptions {
	conversationPanels: Pick<ReturnType<typeof getConversationPanels>, 'panel' | 'loadChatSnapshot'>;
	sessions: Pick<ReturnType<typeof getChatSessions>, 'byId' | 'selectedChatId' | 'generateChatTitleFromMessage'>;
	rootModelCatalog: Pick<ReturnType<typeof getModelCatalog>, 'forExecutor'>;
	controller: ConversationSessionController;
	composerState: Pick<ComposerState, 'appendDraftBlock'>;
	branches: ConversationBranchController;
	quickGitBranches: Pick<ReturnType<typeof getGitBranchActions>, 'searchBranchRefs' | 'toggleBranchSort'>;
	workspace: Pick<ReturnType<typeof getWorkspaceCoordinator>, 'composerAnchorSurfaceId'>;
	appShell: Pick<ReturnType<typeof getAppShell>, 'requestComposerFocus'>;
	allowsConversationalActions(chatId: string): boolean;
	editQueuedInput(chatId: string, entry: QueueEntry): void;
	openCommitForPanel(surfaceId: ChatViewSurfaceId, chatId: string): void;
	onChooseProjectFolder(chatId: string): void;
}

export function createConversationPanelActions(options: PanelActionOptions): ConversationPanelActions {
	const { conversationPanels, sessions, rootModelCatalog, controller, composerState,
		branches, quickGitBranches, workspace, appShell, allowsConversationalActions,
		editQueuedInput, openCommitForPanel, onChooseProjectFolder } = options;

	function assertRenderedPanel(surfaceId: ChatViewSurfaceId, chatId: string) {
		const panel = conversationPanels.panel(surfaceId);
		if (panel?.chatId !== chatId || !panel.isPresentationVisible) {
			throw new StaleConversationSurfaceError(surfaceId, chatId);
		}
		return panel;
	}

	return {
		reload(surfaceId, chatId) {
			const panel = assertRenderedPanel(surfaceId, chatId);
			void controller.loadPanelChat(chatId, panel.transcript, (options) =>
				conversationPanels.loadChatSnapshot(chatId, options),
			);
		},
		decidePermission(surfaceId, chatId, permissionOccurrenceId, decision) {
			assertRenderedPanel(surfaceId, chatId);
			controller.handlePermissionDecisionForChat(chatId, permissionOccurrenceId, decision);
		},
		exitPlanMode(surfaceId, chatId, permissionOccurrenceId, choice, plan) {
			assertRenderedPanel(surfaceId, chatId);
			controller.handleExitPlanModeForChat(chatId, permissionOccurrenceId, choice, plan);
		},
		fork(surfaceId, chatId, upToOrdinal) {
			const panel = assertRenderedPanel(surfaceId, chatId);
			void controller.forkChat(chatId, upToOrdinal, panel.transcript);
		},
		clearBefore(surfaceId, chatId, ordinal) {
			const panel = assertRenderedPanel(surfaceId, chatId);
			const chat = sessions.byId[chatId];
			if (!chat || rootModelCatalog.forExecutor(chat.executorId).getAgent(chat.agentId)?.executionPolicy !== 'literal') return;
			controller.clearHistory.requestBeforeMessage(chatId, {
				transcriptViewId: panel.transcript.transcriptViewId,
				lastOrdinal: panel.transcript.lastOrdinal,
			}, ordinal);
		},
		appendToDraft(surfaceId, chatId, block) {
			assertRenderedPanel(surfaceId, chatId);
			if (!allowsConversationalActions(chatId)) return;
			composerState.appendDraftBlock(chatId, block, { allowDuplicate: true });
		},
		async generateTitle(surfaceId, chatId, message, ordinal) {
			assertRenderedPanel(surfaceId, chatId);
			await sessions.generateChatTitleFromMessage(chatId, message, ordinal);
		},
		interruptQueue(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.handleInterruptAndSendForChat(chatId);
		},
		steerQueue(surfaceId, chatId, entry, reorderRevision) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.handleSteerQueuedInputForChat(chatId, entry, reorderRevision);
		},
		pauseQueue(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.pauseQueueForChat(chatId);
		},
		resumeQueue(surfaceId, chatId, pauseId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.resumeQueueForChat(chatId, pauseId);
		},
		reportQueueControlError(_surfaceId, chatId, action, error) {
			controller.handleQueueControlErrorForChat(chatId, action, error);
		},
		editQueue(surfaceId, chatId, entry) {
			assertRenderedPanel(surfaceId, chatId);
			editQueuedInput(chatId, entry);
		},
		moveQueue(surfaceId, chatId, source, target, placement, reorderRevision) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.moveQueueEntryForChat(chatId, source, target, placement, reorderRevision);
		},
		deleteQueue(surfaceId, chatId, entryId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.deleteQueueEntryFromPanelForChat(chatId, entryId);
		},
		stop(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			return controller.handleAbortForChat(chatId);
		},
		openCommit(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			openCommitForPanel(surfaceId, chatId);
		},
		chooseProjectFolder(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			onChooseProjectFolder(chatId);
		},
		toggleBranch(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			return branches.toggleCommitBranchDropdown(surfaceId, chatId);
		},
		closeBranch(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			branches.closeCommitBranchDropdown();
		},
		createBranch(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			void branches.openNewBranchDialog(surfaceId, chatId);
		},
		switchBranch(surfaceId, chatId, branch) {
			assertRenderedPanel(surfaceId, chatId);
			return branches.switchCommitBranch(surfaceId, chatId, branch);
		},
		searchBranches(surfaceId, chatId, query) {
			assertRenderedPanel(surfaceId, chatId);
			const projectPath = sessions.byId[chatId]?.projectPath;
			if (projectPath) void quickGitBranches.searchBranchRefs(projectPath, query);
		},
		sortBranches(surfaceId, chatId, key, query) {
			assertRenderedPanel(surfaceId, chatId);
			const projectPath = sessions.byId[chatId]?.projectPath;
			if (projectPath) void quickGitBranches.toggleBranchSort(projectPath, key, query);
		},
		closeSwitchBranchDialog(surfaceId, chatId) {
			assertRenderedPanel(surfaceId, chatId);
			if (workspace.composerAnchorSurfaceId === surfaceId && sessions.selectedChatId === chatId) {
				appShell.requestComposerFocus();
			}
		},
	};
}
