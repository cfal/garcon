import {
	generateCommitMessage as generateCommitMessageApi,
	getGitWorkbenchSnapshot,
	gitCommitIndex,
	gitStageFile,
	type GitFileChangeFacet,
	type GitChangeStats,
	type GitTreeNode,
	type GitStatusCode,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';

export interface QuickCommitPathIntent {
	path: string;
	desiredSelected: boolean;
	actualSelected: boolean;
	isRunning: boolean;
	runningMode: QuickCommitStageMode | null;
	error: string | null;
}

export interface QuickCommitDirectorySelection {
	checked: boolean;
	mixed: boolean;
	isRunning: boolean;
	error: string | null;
	fileCount: number;
}

export interface QuickCommitDialogDeps {
	refreshSummary?: () => Promise<void>;
	markProjectChanged?: (projectPath: string) => void;
}

type QueueAction = 'generate' | 'commit' | null;
type QuickCommitStageMode = 'stage' | 'unstage';

interface LoadTreeOptions {
	showLoading?: boolean;
	showRefreshing?: boolean;
}

function flattenFileNodes(nodes: GitTreeNode[]): GitTreeNode[] {
	const result: GitTreeNode[] = [];
	for (const node of nodes) {
		if (node.kind === 'file') {
			result.push(node);
			continue;
		}
		if (node.children) result.push(...flattenFileNodes(node.children));
	}
	return result;
}

function findTreeNode(nodes: GitTreeNode[], path: string): GitTreeNode | null {
	for (const node of nodes) {
		if (node.path === path) return node;
		if (node.children) {
			const match = findTreeNode(node.children, path);
			if (match) return match;
		}
	}
	return null;
}

function statsForNode(node: GitTreeNode): GitChangeStats {
	return (
		node.stagedFacet?.stats ??
		node.unstagedFacet?.stats ?? {
			additions: node.additions ?? 0,
			deletions: node.deletions ?? 0,
		}
	);
}

function mergeStats(...stats: Array<GitChangeStats | undefined>): GitChangeStats {
	let additions = 0;
	let deletions = 0;
	let isBinary = false;
	for (const item of stats) {
		if (!item) continue;
		additions += item.additions ?? 0;
		deletions += item.deletions ?? 0;
		isBinary = isBinary || Boolean(item.isBinary);
	}
	return { additions, deletions, ...(isBinary ? { isBinary: true } : {}) };
}

function facetForStage(node: GitTreeNode): GitFileChangeFacet | undefined {
	const stagedFacet = node.stagedFacet;
	const unstagedFacet = node.unstagedFacet;
	const source = unstagedFacet ?? stagedFacet;
	if (!source) return undefined;
	const stats = mergeStats(stagedFacet?.stats, unstagedFacet?.stats);
	return {
		...source,
		status: source.status === '?' ? 'A' : source.status,
		changeKind: source.changeKind === 'untracked' ? 'added' : source.changeKind,
		stats,
	};
}

function facetForUnstage(node: GitTreeNode): GitFileChangeFacet | undefined {
	const stagedFacet = node.stagedFacet;
	const unstagedFacet = node.unstagedFacet;
	const source = unstagedFacet ?? stagedFacet;
	if (!source) return undefined;
	const addedOnly = stagedFacet?.changeKind === 'added' && !unstagedFacet;
	const changeKind = addedOnly ? 'untracked' : source.changeKind;
	const status: GitStatusCode = addedOnly ? '?' : source.status;
	return {
		...source,
		status,
		changeKind,
		stats: mergeStats(unstagedFacet?.stats, stagedFacet?.stats),
	};
}

function reconcileFileNodeAfterStage(node: GitTreeNode, staged: boolean): GitTreeNode {
	if (staged) {
		const stagedFacet = facetForStage(node);
		return {
			...node,
			indexStatus: stagedFacet?.status ?? 'M',
			workTreeStatus: ' ',
			stagedFacet,
			unstagedFacet: undefined,
			changeKind: stagedFacet?.changeKind ?? node.changeKind,
			staged: true,
			hasUnstaged: false,
			additions: stagedFacet?.stats.additions ?? node.additions,
			deletions: stagedFacet?.stats.deletions ?? node.deletions,
			category: stagedFacet?.category ?? node.category,
		};
	}

	const unstagedFacet = facetForUnstage(node);
	return {
		...node,
		indexStatus: ' ',
		workTreeStatus: unstagedFacet?.status ?? 'M',
		stagedFacet: undefined,
		unstagedFacet,
		changeKind: unstagedFacet?.changeKind ?? node.changeKind,
		staged: false,
		hasUnstaged: true,
		additions: unstagedFacet?.stats.additions ?? node.additions,
		deletions: unstagedFacet?.stats.deletions ?? node.deletions,
		category: unstagedFacet?.category ?? node.category,
	};
}

function aggregateDirectoryNode(node: GitTreeNode, children: GitTreeNode[]): GitTreeNode {
	let staged = false;
	let hasUnstaged = false;
	let additions = 0;
	let deletions = 0;
	let stagedFacet: GitFileChangeFacet | undefined;
	let unstagedFacet: GitFileChangeFacet | undefined;
	for (const child of children) {
		staged = staged || child.staged;
		hasUnstaged = hasUnstaged || child.hasUnstaged;
		additions += child.additions ?? 0;
		deletions += child.deletions ?? 0;
		stagedFacet = stagedFacet ?? child.stagedFacet;
		unstagedFacet = unstagedFacet ?? child.unstagedFacet;
	}
	return {
		...node,
		children,
		staged,
		hasUnstaged,
		stagedFacet,
		unstagedFacet,
		changeKind: unstagedFacet?.changeKind ?? stagedFacet?.changeKind,
		indexStatus: staged ? 'M' : ' ',
		workTreeStatus: hasUnstaged ? 'M' : ' ',
		additions,
		deletions,
	};
}

function reconcileTreeAfterStage(
	nodes: GitTreeNode[],
	path: string,
	staged: boolean,
): { nodes: GitTreeNode[]; changed: boolean } {
	let changed = false;
	const next = nodes.map((node) => {
		if (node.kind === 'file') {
			if (node.path !== path) return node;
			changed = true;
			return reconcileFileNodeAfterStage(node, staged);
		}
		if (!node.children) return node;
		const childResult = reconcileTreeAfterStage(node.children, path, staged);
		if (!childResult.changed) return node;
		changed = true;
		return aggregateDirectoryNode(node, childResult.nodes);
	});
	return { nodes: next, changed };
}

export class QuickCommitDialogState {
	isOpen = $state(false);
	projectPath = $state<string | null>(null);
	tree = $state<GitTreeNode[]>([]);
	intents = $state<Record<string, QuickCommitPathIntent>>({});
	message = $state('');
	isLoadingTree = $state(false);
	isRefreshingTree = $state(false);
	isProcessingQueue = $state(false);
	isGeneratingMessage = $state(false);
	isCommitting = $state(false);
	preparingAction = $state<QueueAction>(null);
	lastError = $state<string | null>(null);

	private queue: string[] = [];
	private forcedStagePaths = new Set<string>();
	private queueSettledPromise: Promise<void> | null = null;
	private resolveQueueSettled: (() => void) | null = null;
	private shouldRefreshAfterDrain = false;

	constructor(private readonly deps: QuickCommitDialogDeps) {}

	get fileNodes(): GitTreeNode[] {
		return flattenFileNodes(this.tree);
	}

	get hasPendingStageOperations(): boolean {
		return Object.values(this.intents).some(
			(item) => item.desiredSelected !== item.actualSelected || item.isRunning,
		);
	}

	get hasErrors(): boolean {
		return Object.values(this.intents).some((item) => Boolean(item.error));
	}

	get treeErrorMessage(): string | null {
		const fileErrors = Object.values(this.intents)
			.filter((item) => Boolean(item.error))
			.map((item) => item.error as string);
		const firstFileError = fileErrors[0] ?? null;

		if (this.lastError && !firstFileError) return this.lastError;
		if (!this.lastError && !firstFileError) return null;
		if (this.lastError && firstFileError) {
			return m.git_quick_commit_error_with_detail({
				summary: this.lastError,
				detail: this.fileErrorSummary(fileErrors),
			});
		}
		return this.fileErrorSummary(fileErrors);
	}

	get desiredSelectedFiles(): string[] {
		return Object.values(this.intents)
			.filter((item) => item.desiredSelected)
			.map((item) => item.path);
	}

	get actualSelectedFiles(): string[] {
		return Object.values(this.intents)
			.filter((item) => item.actualSelected)
			.map((item) => item.path);
	}

	get selectedFileCount(): number {
		return this.desiredSelectedFiles.length;
	}

	get totalAdditions(): number {
		return this.selectedStats().additions;
	}

	get totalDeletions(): number {
		return this.selectedStats().deletions;
	}

	get canCommit(): boolean {
		return (
			this.message.trim().length > 0 &&
			this.desiredSelectedFiles.length > 0 &&
			!this.isCommitting &&
			!this.hasErrors
		);
	}

	async open(projectPath: string): Promise<void> {
		this.resetForOpen(projectPath);
		this.isOpen = true;
		await this.deps.refreshSummary?.();
		await this.loadTree(false);
	}

	close(): void {
		if (this.isCommitting) return;
		this.isOpen = false;
	}

	intentFor(path: string): QuickCommitPathIntent | null {
		return this.intents[path] ?? null;
	}

	directorySelection(path: string): QuickCommitDirectorySelection {
		const node = findTreeNode(this.tree, path);
		const files = node ? flattenFileNodes([node]) : [];
		const intents = files
			.map((file) => this.intentFor(file.path))
			.filter((item): item is QuickCommitPathIntent => Boolean(item));
		const selectedCount = intents.filter((item) => item.desiredSelected).length;
		const checked = intents.length > 0 && selectedCount === intents.length;
		return {
			checked,
			mixed: selectedCount > 0 && selectedCount < intents.length,
			isRunning: intents.some((item) => item.isRunning),
			error: intents.find((item) => item.error)?.error ?? null,
			fileCount: intents.length,
		};
	}

	nodeStats(path: string): GitChangeStats {
		const node = this.fileNodes.find((candidate) => candidate.path === path);
		return node ? statsForNode(node) : { additions: 0, deletions: 0 };
	}

	togglePath(path: string, desiredSelected: boolean): void {
		const queued = this.enqueueStageIntent(path, desiredSelected);
		if (queued) void this.drainQueue();
	}

	toggleDirectory(path: string, desiredSelected: boolean): void {
		const node = findTreeNode(this.tree, path);
		if (!node) return;
		let queued = false;
		for (const file of flattenFileNodes([node])) {
			queued = this.enqueueStageIntent(file.path, desiredSelected) || queued;
		}
		if (queued) void this.drainQueue();
	}

	includeUnstaged(path: string): void {
		const queued = this.enqueueStageIntent(path, true, true);
		if (queued) void this.drainQueue();
	}

	operationLabelForPath(path: string): string {
		const item = this.intents[path];
		const mode = item?.runningMode ?? (item?.desiredSelected ? 'unstage' : 'stage');
		return mode === 'stage'
			? m.git_quick_commit_stage_path({ path })
			: m.git_quick_commit_unstage_path({ path });
	}

	async refreshTree(): Promise<void> {
		if (!this.projectPath) return;
		await Promise.all([
			this.loadTree(true, {
				showLoading: this.tree.length === 0,
				showRefreshing: true,
			}),
			this.deps.refreshSummary?.() ?? Promise.resolve(),
		]);
	}

	async generateMessage(): Promise<void> {
		if (!this.projectPath || this.isGeneratingMessage) return;
		this.preparingAction = 'generate';
		const queueReady = await this.waitForQueue();
		this.preparingAction = null;
		if (!queueReady) {
			this.lastError = 'Resolve staging errors before generating a commit message.';
			return;
		}

		const files = this.actualSelectedFiles;
		if (files.length === 0) {
			this.lastError = 'No staged files to generate message for.';
			return;
		}

		this.isGeneratingMessage = true;
		try {
			const data = await generateCommitMessageApi(this.projectPath, files);
			if (!data.message) {
				this.lastError = data.error ?? 'Failed to generate commit message.';
				return;
			}
			this.message = data.message;
			this.lastError = null;
		} catch (error) {
			this.lastError = this.commitMessageGenerationErrorMessage(error);
		} finally {
			this.isGeneratingMessage = false;
		}
	}

	async commit(): Promise<boolean> {
		if (!this.projectPath || this.isCommitting || !this.message.trim()) return false;
		this.preparingAction = 'commit';
		const queueReady = await this.waitForQueue();
		this.preparingAction = null;
		if (!queueReady) {
			this.lastError = 'Resolve staging errors before committing.';
			return false;
		}
		if (this.actualSelectedFiles.length === 0) {
			this.lastError = 'No staged files to commit.';
			return false;
		}

		this.isCommitting = true;
		try {
			const result = await gitCommitIndex(this.projectPath, this.message.trim());
			if (!result.success) {
				this.lastError = result.error ?? 'Commit failed.';
				await this.refreshAfterMutation();
				return false;
			}
			this.message = '';
			this.isOpen = false;
			this.lastError = null;
			this.deps.markProjectChanged?.(this.projectPath);
			await this.refreshAfterMutation();
			return true;
		} catch (error) {
			this.lastError = `Commit failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.refreshAfterMutation();
			return false;
		} finally {
			this.isCommitting = false;
		}
	}

	async waitForQueue(): Promise<boolean> {
		await this.queueSettledPromise;
		return !this.hasPendingStageOperations && !this.hasErrors;
	}

	private async drainQueue(): Promise<void> {
		if (this.isProcessingQueue || !this.projectPath) return;
		this.isProcessingQueue = true;
		try {
			while (this.queue.length > 0) {
				const path = this.queue.shift();
				if (!path) continue;
				const item = this.intents[path];
				const shouldForceStage = this.forcedStagePaths.has(path);
				this.forcedStagePaths.delete(path);
				if (!item || (!shouldForceStage && item.desiredSelected === item.actualSelected)) continue;
				await this.applyStageIntent(path, shouldForceStage ? true : item.desiredSelected);
			}
		} finally {
			this.isProcessingQueue = false;
			if (this.shouldRefreshAfterDrain) {
				this.shouldRefreshAfterDrain = false;
				this.markQueueSettled();
				this.startRefreshAfterMutation();
			} else {
				this.markQueueSettled();
			}
		}
	}

	private async applyStageIntent(path: string, desiredSelected: boolean): Promise<void> {
		if (!this.projectPath) return;
		this.setIntent(path, {
			isRunning: true,
			runningMode: desiredSelected ? 'stage' : 'unstage',
			error: null,
		});
		try {
			const result = await gitStageFile(this.projectPath, path, desiredSelected ? 'stage' : 'unstage');
			if (!result.success) {
				throw new Error(result.error ?? 'Git stage operation failed.');
			}
			this.reconcilePathAfterStage(path, desiredSelected);
			this.setIntent(path, {
				actualSelected: desiredSelected,
				error: null,
			});
			this.shouldRefreshAfterDrain = true;
			this.deps.markProjectChanged?.(this.projectPath);
		} catch (error) {
			const current = this.intents[path];
			this.setIntent(path, {
				desiredSelected: current?.actualSelected ?? false,
				error: error instanceof Error ? error.message : String(error),
			});
			this.shouldRefreshAfterDrain = true;
		} finally {
			this.setIntent(path, { isRunning: false, runningMode: null });
		}
	}

	private async loadTree(preserveDesired: boolean, options: LoadTreeOptions = {}): Promise<void> {
		if (!this.projectPath) return;
		const showLoading = options.showLoading ?? true;
		const showRefreshing = options.showRefreshing ?? !showLoading;
		if (showLoading) this.isLoadingTree = true;
		if (showRefreshing) this.isRefreshingTree = true;
		try {
			const snapshot = await getGitWorkbenchSnapshot(this.projectPath, 'unstaged', 0, {
				bodyCandidateCount: 1,
			});
			if (snapshot.status !== 'ready') {
				this.tree = [];
				this.intents = {};
				this.lastError = snapshot.message;
				return;
			}
			this.applyTree(snapshot.tree.root, preserveDesired);
			this.lastError = null;
		} catch (error) {
			this.lastError = `Failed to load changed files: ${
				error instanceof Error ? error.message : String(error)
			}`;
		} finally {
			if (showLoading) this.isLoadingTree = false;
			if (showRefreshing) this.isRefreshingTree = false;
		}
	}

	private applyTree(tree: GitTreeNode[], preserveDesired: boolean): void {
		const previous = this.intents;
		const nextIntents: Record<string, QuickCommitPathIntent> = {};
		for (const node of flattenFileNodes(tree)) {
			const actualSelected = Boolean(node.staged);
			const previousIntent = previous[node.path];
			const hasPendingOperation =
				Boolean(previousIntent?.isRunning) || this.queue.includes(node.path);
			const shouldPreserveDesired =
				preserveDesired && Boolean(previousIntent) && !previousIntent?.error && hasPendingOperation;
			nextIntents[node.path] = {
				path: node.path,
				actualSelected,
				desiredSelected: shouldPreserveDesired
					? (previousIntent?.desiredSelected ?? actualSelected)
					: actualSelected,
				isRunning: previousIntent?.isRunning ?? false,
				runningMode: previousIntent?.runningMode ?? null,
				error: previousIntent?.error ?? null,
			};
		}
		this.tree = tree;
		this.intents = nextIntents;
	}

	private async refreshAfterMutation(): Promise<void> {
		await Promise.all([
			this.loadTree(true, { showLoading: false, showRefreshing: true }),
			this.deps.refreshSummary?.() ?? Promise.resolve(),
		]);
	}

	private startRefreshAfterMutation(): void {
		void this.refreshAfterMutation().catch((error) => {
			this.lastError = `Failed to refresh changed files: ${
				error instanceof Error ? error.message : String(error)
			}`;
		});
	}

	private selectedStats(): GitChangeStats {
		let additions = 0;
		let deletions = 0;
		for (const node of this.fileNodes) {
			const intent = this.intentFor(node.path);
			if (!intent?.desiredSelected) continue;
			const stats = statsForNode(node);
			additions += stats.additions;
			deletions += stats.deletions;
		}
		return { additions, deletions };
	}

	private fileErrorSummary(errors: string[]): string {
		const first = errors[0] ?? '';
		if (errors.length <= 1) return first;
		return m.git_quick_commit_file_errors({
			count: errors.length,
			message: first,
		});
	}

	private setIntent(path: string, patch: Partial<QuickCommitPathIntent>): void {
		const current = this.intents[path];
		if (!current) return;
		this.intents = {
			...this.intents,
			[path]: { ...current, ...patch },
		};
	}

	private enqueueStageIntent(
		path: string,
		desiredSelected: boolean,
		forceStage = false,
	): boolean {
		const item = this.intents[path];
		if (!item) return false;
		this.setIntent(path, {
			desiredSelected,
			error: null,
		});
		if (forceStage) this.forcedStagePaths.add(path);
		const needsOperation = forceStage || item.actualSelected !== desiredSelected || item.isRunning;
		if (!needsOperation) return false;
		if (!this.queue.includes(path)) this.queue.push(path);
		this.markQueueActive();
		return true;
	}

	private reconcilePathAfterStage(path: string, desiredSelected: boolean): void {
		const result = reconcileTreeAfterStage(this.tree, path, desiredSelected);
		if (result.changed) this.tree = result.nodes;
	}

	private markQueueActive(): void {
		if (this.queueSettledPromise) return;
		this.queueSettledPromise = new Promise((resolve) => {
			this.resolveQueueSettled = resolve;
		});
	}

	private markQueueSettled(): void {
		if (!this.queueSettledPromise || this.hasPendingStageOperations || this.queue.length > 0) return;
		this.resolveQueueSettled?.();
		this.queueSettledPromise = null;
		this.resolveQueueSettled = null;
	}

	private resetForOpen(projectPath: string): void {
		this.projectPath = projectPath;
		this.tree = [];
		this.intents = {};
		this.queue = [];
		this.forcedStagePaths = new Set();
		this.queueSettledPromise = null;
		this.resolveQueueSettled = null;
		this.shouldRefreshAfterDrain = false;
		this.isLoadingTree = true;
		this.isRefreshingTree = false;
		this.isProcessingQueue = false;
		this.isGeneratingMessage = false;
		this.isCommitting = false;
		this.preparingAction = null;
		this.lastError = null;
	}

	private commitMessageGenerationErrorMessage(error: unknown): string {
		if (!(error instanceof ApiError)) {
			return `Generate message failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		switch (error.errorCode) {
			case 'commit_message_no_staged_files':
				return m.git_commit_message_errors_no_staged_files();
			case 'commit_message_agent_auth_required':
				return m.git_commit_message_errors_agent_auth_required();
			case 'commit_message_agent_unavailable':
				return m.git_commit_message_errors_agent_unavailable();
			case 'commit_message_rate_limited':
				return m.git_commit_message_errors_rate_limited();
			case 'commit_message_timeout':
				return m.git_commit_message_errors_timeout();
			case 'commit_message_empty_response':
				return m.git_commit_message_errors_empty_response();
			case 'commit_message_invalid_response':
				return m.git_commit_message_errors_invalid_response();
			case 'commit_message_generation_failed':
			default:
				return m.git_commit_message_errors_generation_failed();
		}
	}
}
