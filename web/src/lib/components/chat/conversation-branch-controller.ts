import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import type { ConversationPanelRegistration } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import type {
	getChatSessions, getExecutors, getConversationPanels, getWorkspaceCoordinator,
	getGitBranchActions, getGitQuickSummary, getProjectResolution,
} from '$lib/context';

interface BranchControllerOptions {
	sessions: Pick<ReturnType<typeof getChatSessions>, 'byId'>;
	executors: Pick<ReturnType<typeof getExecutors>, 'gitAvailable' | 'gitContextKey'>;
	conversationPanels: Pick<ReturnType<typeof getConversationPanels>, 'panel'>;
	workspace: Pick<ReturnType<typeof getWorkspaceCoordinator>, 'focusOwner' | 'focusOwnerRevision'>;
	quickGitBranches: ReturnType<typeof getGitBranchActions>;
	quickGit: Pick<ReturnType<typeof getGitQuickSummary>, 'summaryFor'>;
	projectResolution: Pick<ReturnType<typeof getProjectResolution>, 'retain'>;
}

type BranchCommand = {
	readonly executorId: string;
	readonly projectPath: string;
	readonly generation: number;
	readonly surfaceId: ChatViewSurfaceId;
	readonly chatId: string;
	readonly focusOwnerRevision: number;
	readonly panel: ConversationPanelRegistration;
};

export class ConversationBranchController {
	#branchCommandGeneration = 0;
	#branchDropdownGeneration: number | null = null;

	constructor(private readonly options: BranchControllerOptions) {}

	async toggleCommitBranchDropdown(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
	): Promise<void> {
		const command = this.#beginBranchCommand(surfaceId, chatId, true);
		if (!command) return;
		const projectPath = this.options.sessions.byId[chatId]?.projectPath;
		if (!projectPath) return;
		if (
			this.options.quickGitBranches.executorId === command.executorId &&
			this.options.quickGitBranches.currentProjectPath === projectPath &&
			this.options.quickGitBranches.showBranchDropdown
		) {
			this.closeCommitBranchDropdown();
			return;
		}
		const project = await this.#resolveChatProject(chatId);
		if (!project || !this.#ownsBranchCommand(command)) return;
		this.options.quickGitBranches.setProject(
			project.projectPath,
			this.options.quickGit.summaryFor(project)?.branch,
			project.effectiveProjectKey,
			project.executorId,
		);
		await this.options.quickGitBranches.openBranchDropdown(project.projectPath, project.effectiveProjectKey);
		if (command.generation === this.#branchCommandGeneration && !this.#ownsBranchCommand(command)) {
			this.options.quickGitBranches.closeBranchDropdown();
		}
	}

	#beginBranchCommand(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		opensDropdown = false,
	): BranchCommand | null {
		const chat = this.options.sessions.byId[chatId];
		const executorId = chat?.executorId ?? 'local';
		if (!chat?.projectPath || !this.options.executors.gitAvailable(executorId)) return null;
		const panel = this.options.conversationPanels.panel(surfaceId);
		const owner = this.options.workspace.focusOwner;
		if (
			!panel ||
			panel.chatId !== chatId ||
			owner.kind === 'chat-list' ||
			owner.surfaceId !== surfaceId
		) {
			return null;
		}
		const generation = ++this.#branchCommandGeneration;
		if (opensDropdown) this.#branchDropdownGeneration = generation;
		return {
			executorId,
			projectPath: chat.projectPath,
			generation,
			surfaceId,
			chatId,
			focusOwnerRevision: this.options.workspace.focusOwnerRevision,
			panel,
		};
	}

	#ownsBranchCommand(command: BranchCommand): boolean {
		return (
			(this.options.sessions.byId[command.chatId]?.executorId ?? 'local') === command.executorId &&
			this.options.sessions.byId[command.chatId]?.projectPath === command.projectPath &&
			this.options.executors.gitAvailable(command.executorId) &&
			command.generation === this.#branchCommandGeneration &&
			this.options.workspace.focusOwnerRevision === command.focusOwnerRevision &&
			this.options.workspace.focusOwner.kind !== 'chat-list' &&
			this.options.workspace.focusOwner.surfaceId === command.surfaceId &&
			this.options.conversationPanels.panel(command.surfaceId) === command.panel &&
			command.panel.chatId === command.chatId
		);
	}

	closeCommitBranchDropdown(): void {
		if (this.#branchDropdownGeneration === this.#branchCommandGeneration) this.#branchCommandGeneration += 1;
		this.#branchDropdownGeneration = null;
		this.options.quickGitBranches.closeBranchDropdown();
	}

	async openNewBranchDialog(surfaceId: ChatViewSurfaceId, chatId: string): Promise<void> {
		const command = this.#beginBranchCommand(surfaceId, chatId);
		if (!command) return;
		const project = await this.#resolveChatProject(chatId);
		if (!project || !this.#ownsBranchCommand(command)) return;
		this.options.quickGitBranches.setProject(
			project.projectPath,
			this.options.quickGit.summaryFor(project)?.branch,
			project.effectiveProjectKey,
			project.executorId,
		);
		this.options.quickGitBranches.openNewBranchDialog(
			project.projectPath,
			surfaceId,
			project.effectiveProjectKey,
		);
	}

	async switchCommitBranch(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		branch: string,
	): Promise<void> {
		const command = this.#beginBranchCommand(surfaceId, chatId);
		if (!command) return;
		const project = await this.#resolveChatProject(chatId);
		if (!project || !this.#ownsBranchCommand(command)) return;
		this.options.quickGitBranches.setProject(
			project.projectPath,
			this.options.quickGit.summaryFor(project)?.branch,
			project.effectiveProjectKey,
			project.executorId,
		);
		await this.options.quickGitBranches.switchBranch(
			project.projectPath,
			branch,
			undefined,
			surfaceId,
			project.effectiveProjectKey,
		);
	}

	async #resolveChatProject(chatId: string): Promise<{
		executorId: string;
		projectPath: string;
		effectiveProjectKey: string;
	} | null> {
		const chat = this.options.sessions.byId[chatId];
		const executorId = chat?.executorId ?? 'local';
		const executorContextKey = this.options.executors.gitContextKey(executorId);
		if (!chat?.projectPath || !this.options.executors.gitAvailable(executorId)) return null;
		const target =
			chat.status === 'draft'
				? { kind: 'path' as const, executorId, projectPath: chat.projectPath }
				: { kind: 'chat' as const, executorId, chatId, projectPath: chat.projectPath };
		const lease = this.options.projectResolution.retain(target);
		try {
			await lease.resolve();
			if (
				this.options.sessions.byId[chatId]?.projectPath !== target.projectPath ||
				(this.options.sessions.byId[chatId]?.executorId ?? 'local') !== executorId ||
				executorContextKey !== this.options.executors.gitContextKey(executorId) ||
				!this.options.executors.gitAvailable(executorId)
			)
				return null;
			return lease.snapshot.kind === 'available'
				? {
						executorId,
						projectPath: target.projectPath,
						effectiveProjectKey: lease.snapshot.effectiveProjectKey,
					}
				: null;
		} finally {
			lease.release();
		}
	}
}
