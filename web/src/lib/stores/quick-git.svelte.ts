import {
	generateCommitMessage as generateCommitMessageApi,
	getGitWorkbenchSnapshot,
	gitCommitIndex,
	gitStagePaths,
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

export interface QuickGitControllerDeps {
	refreshSummary?: () => Promise<void>;
	markProjectChanged?: (effectiveProjectKey: string, projectPath: string) => void;
	runMutation?: <T>(request: {
		effectiveProjectKey: string;
		projectPath: string;
		execute: () => Promise<T>;
		didMutate: (result: T) => boolean;
	}) => Promise<T>;
}

interface QuickGitProjectSnapshot {
	projectPath: string;
	tree: GitTreeNode[];
	intents: Record<string, QuickCommitPathIntent>;
	message: string;
	accessedAt: number;
}

type QueueAction = 'generate' | 'commit' | null;
type QuickCommitStageMode = 'stage' | 'unstage';
type QuickCommitTreeLoadState = 'idle' | 'initial-loading' | 'refreshing';

interface QuickCommitStageBatch {
	mode: QuickCommitStageMode;
	paths: string[];
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
	paths: Set<string>,
	staged: boolean,
): { nodes: GitTreeNode[]; changed: boolean } {
	let changed = false;
	const next = nodes.map((node) => {
		if (node.kind === 'file') {
			if (!paths.has(node.path)) return node;
			changed = true;
			return reconcileFileNodeAfterStage(node, staged);
		}
		if (!node.children) return node;
		const childResult = reconcileTreeAfterStage(node.children, paths, staged);
		if (!childResult.changed) return node;
		changed = true;
		return aggregateDirectoryNode(node, childResult.nodes);
	});
	return { nodes: next, changed };
}

export class QuickGitController {
	effectiveProjectKey = $state<string | null>(null);
	projectPath = $state<string | null>(null);
	tree = $state<GitTreeNode[]>([]);
	intents = $state<Record<string, QuickCommitPathIntent>>({});
	message = $state('');
	treeLoadState = $state<QuickCommitTreeLoadState>('idle');
	isProcessingQueue = $state(false);
	isGeneratingMessage = $state(false);
	isCommitting = $state(false);
	pendingMutationCount = $state(0);
	preparingAction = $state<QueueAction>(null);
	lastError = $state<string | null>(null);
	isPresentationVisible = $state(false);

	private queue: string[] = [];
	private forcedStagePaths = new Set<string>();
	private queueSettledPromise: Promise<void> | null = null;
	private resolveQueueSettled: (() => void) | null = null;
	private shouldRefreshAfterDrain = false;
	private snapshots = new Map<string, QuickGitProjectSnapshot>();
	private activationPromise: Promise<void> | null = null;
	private disposed = false;
	private contextGeneration = 0;

	constructor(private readonly deps: QuickGitControllerDeps) {}

	get fileNodes(): GitTreeNode[] {
		return flattenFileNodes(this.tree);
	}

	get isLoadingTree(): boolean {
		return this.treeLoadState === 'initial-loading';
	}

	get isRefreshingTree(): boolean {
		return this.treeLoadState === 'refreshing';
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

	get retainedDraftCount(): number {
		let count = this.message.trim() ? 1 : 0;
		for (const [key, snapshot] of this.snapshots) {
			if (key !== this.effectiveProjectKey && snapshot.message.trim()) count += 1;
		}
		return count;
	}

	get canClose(): boolean {
		return (
			this.pendingMutationCount === 0 &&
			!this.isCommitting &&
			!this.isGeneratingMessage &&
			!this.isProcessingQueue
		);
	}

	async setContext(effectiveProjectKey: string | null, projectPath: string | null): Promise<void> {
		if (this.disposed) return;
		if (effectiveProjectKey === this.effectiveProjectKey) {
			this.projectPath = projectPath;
			if (this.isPresentationVisible && this.tree.length === 0) await this.activate();
			return;
		}
		this.saveCurrentSnapshot();
		this.resetForContext(effectiveProjectKey, projectPath);
		if (effectiveProjectKey) this.restoreSnapshot(effectiveProjectKey);
		if (this.isPresentationVisible) await this.activate();
	}

	async setPresentationVisible(visible: boolean): Promise<void> {
		if (this.disposed || this.isPresentationVisible === visible) return;
		this.isPresentationVisible = visible;
		if (visible) await this.activate();
	}

	discardDrafts(): void {
		this.message = '';
		for (const [key, snapshot] of this.snapshots) {
			this.snapshots.set(key, { ...snapshot, message: '' });
		}
	}

	resetAfterClose(): void {
		this.snapshots.clear();
		this.isPresentationVisible = false;
		this.activationPromise = null;
		this.resetForContext(this.effectiveProjectKey, this.projectPath);
	}

	dispose(): void {
		this.disposed = true;
		this.saveCurrentSnapshot();
		this.queue = [];
		this.forcedStagePaths.clear();
		this.isPresentationVisible = false;
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
			this.tree.length === 0 ? this.loadInitialTree() : this.refreshTreeSnapshot(),
			this.deps.refreshSummary?.() ?? Promise.resolve(),
		]);
	}

	async generateMessage(): Promise<void> {
		const projectPath = this.projectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		const generation = this.contextGeneration;
		if (!projectPath || !effectiveProjectKey || this.isGeneratingMessage) return;
		this.preparingAction = 'generate';
		const queueReady = await this.waitForQueue();
		if (generation !== this.contextGeneration || effectiveProjectKey !== this.effectiveProjectKey) {
			return;
		}
		this.preparingAction = null;
		if (!queueReady) {
			this.lastError = m.git_quick_commit_resolve_errors_before_generate();
			return;
		}

		const files = this.actualSelectedFiles;
		if (files.length === 0) {
			this.lastError = m.git_quick_commit_no_staged_files_for_message();
			return;
		}

		this.isGeneratingMessage = true;
		try {
			const data = await generateCommitMessageApi(projectPath, files);
			if (
				generation !== this.contextGeneration ||
				effectiveProjectKey !== this.effectiveProjectKey
			) {
				return;
			}
			if (!data.message) {
				this.lastError = data.error ?? m.quick_git_generate_failed();
				return;
			}
			this.message = data.message;
			this.lastError = null;
		} catch (error) {
			if (
				generation === this.contextGeneration &&
				effectiveProjectKey === this.effectiveProjectKey
			) {
				this.lastError = this.commitMessageGenerationErrorMessage(error);
			}
		} finally {
			if (generation === this.contextGeneration) this.isGeneratingMessage = false;
		}
	}

	async commit(): Promise<boolean> {
		const projectPath = this.projectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		const message = this.message.trim();
		const generation = this.contextGeneration;
		if (!projectPath || !effectiveProjectKey || this.isCommitting || !message) return false;
		this.preparingAction = 'commit';
		const queueReady = await this.waitForQueue();
		if (generation !== this.contextGeneration || effectiveProjectKey !== this.effectiveProjectKey) {
			return false;
		}
		this.preparingAction = null;
		if (!queueReady) {
			this.lastError = m.git_quick_commit_resolve_errors_before_commit();
			return false;
		}
		if (this.actualSelectedFiles.length === 0) {
			this.lastError = m.git_quick_commit_no_staged_files_to_commit();
			return false;
		}

		this.isCommitting = true;
		this.pendingMutationCount += 1;
		try {
			const execute = () => gitCommitIndex(projectPath, message);
			const result = this.deps.runMutation
				? await this.deps.runMutation({
						effectiveProjectKey,
						projectPath,
						execute,
						didMutate: (response) => response.success,
					})
				: await execute();
			if (!result.success) {
				if (this.effectiveProjectKey === effectiveProjectKey) {
					this.lastError = result.error ?? m.quick_git_commit_failed();
					await this.refreshAfterMutation();
				}
				return false;
			}
			if (this.effectiveProjectKey === effectiveProjectKey) {
				this.message = '';
				this.lastError = null;
			}
			if (!this.deps.runMutation) {
				this.deps.markProjectChanged?.(effectiveProjectKey, projectPath);
			}
			await this.deps.refreshSummary?.();
			return true;
		} catch (error) {
			if (this.effectiveProjectKey === effectiveProjectKey) {
				this.lastError = m.quick_git_commit_failed_detail({
					detail: error instanceof Error ? error.message : String(error),
				});
				await this.refreshAfterMutation();
			}
			return false;
		} finally {
			this.pendingMutationCount -= 1;
			if (this.effectiveProjectKey === effectiveProjectKey) this.isCommitting = false;
		}
	}

	async waitForQueue(): Promise<boolean> {
		await this.queueSettledPromise;
		return !this.hasPendingStageOperations && !this.hasErrors;
	}

	private async drainQueue(): Promise<void> {
		if (this.isProcessingQueue || !this.projectPath) return;
		const generation = this.contextGeneration;
		this.isProcessingQueue = true;
		try {
			while (generation === this.contextGeneration && this.queue.length > 0) {
				const batch = this.collectNextBatch();
				if (!batch) break;
				await this.applyStageBatch(batch);
			}
		} finally {
			if (generation === this.contextGeneration) {
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
	}

	private collectNextBatch(): QuickCommitStageBatch | null {
		let mode: QuickCommitStageMode | null = null;
		const paths: string[] = [];
		const remaining: string[] = [];

		for (const path of this.queue) {
			const item = this.intents[path];
			const forceStage = this.forcedStagePaths.has(path);
			const nextMode = forceStage
				? 'stage'
				: item && item.desiredSelected !== item.actualSelected
					? item.desiredSelected
						? 'stage'
						: 'unstage'
					: null;

			if (!item || !nextMode) {
				this.forcedStagePaths.delete(path);
				continue;
			}

			if (!mode) mode = nextMode;
			if (nextMode === mode) {
				paths.push(path);
				this.forcedStagePaths.delete(path);
			} else {
				remaining.push(path);
			}
		}

		this.queue = remaining;
		return mode && paths.length > 0 ? { mode, paths } : null;
	}

	private async applyStageBatch(batch: QuickCommitStageBatch): Promise<void> {
		const projectPath = this.projectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		if (!projectPath || !effectiveProjectKey) return;
		for (const path of batch.paths) {
			this.setIntent(path, {
				isRunning: true,
				runningMode: batch.mode,
				error: null,
			});
		}
		this.pendingMutationCount += 1;
		try {
			const execute = () => gitStagePaths(projectPath, batch.paths, batch.mode);
			const result = this.deps.runMutation
				? await this.deps.runMutation({
						effectiveProjectKey,
						projectPath,
						execute,
						didMutate: (response) => response.success,
					})
				: await execute();
			if (!result.success) {
				throw new Error(result.error ?? m.git_quick_commit_stage_operation_failed());
			}
			if (this.effectiveProjectKey !== effectiveProjectKey) {
				if (!this.deps.runMutation) {
					this.deps.markProjectChanged?.(effectiveProjectKey, projectPath);
				}
				return;
			}
			this.reconcilePathsAfterStage(batch.paths, batch.mode === 'stage');
			for (const path of batch.paths) {
				this.setIntent(path, {
					actualSelected: batch.mode === 'stage',
					error: null,
				});
			}
			this.shouldRefreshAfterDrain = true;
			if (!this.deps.runMutation) {
				this.deps.markProjectChanged?.(effectiveProjectKey, projectPath);
			}
		} catch (error) {
			if (this.effectiveProjectKey !== effectiveProjectKey) return;
			const message = error instanceof Error ? error.message : String(error);
			for (const path of batch.paths) {
				const current = this.intents[path];
				this.setIntent(path, {
					desiredSelected: current?.actualSelected ?? false,
					error: message,
				});
			}
			this.shouldRefreshAfterDrain = true;
		} finally {
			this.pendingMutationCount -= 1;
			if (this.effectiveProjectKey === effectiveProjectKey) {
				for (const path of batch.paths) {
					this.setIntent(path, { isRunning: false, runningMode: null });
				}
			}
		}
	}

	private async loadInitialTree(): Promise<void> {
		const generation = this.contextGeneration;
		this.treeLoadState = 'initial-loading';
		try {
			await this.loadTreeSnapshot({ preserveDesired: false, clearOnNotReady: true });
		} finally {
			if (generation === this.contextGeneration) this.treeLoadState = 'idle';
		}
	}

	private async refreshTreeSnapshot(): Promise<void> {
		if (!this.projectPath) return;
		const generation = this.contextGeneration;
		this.treeLoadState = 'refreshing';
		try {
			await this.loadTreeSnapshot({ preserveDesired: true, clearOnNotReady: false });
		} finally {
			if (generation === this.contextGeneration) this.treeLoadState = 'idle';
		}
	}

	private async loadTreeSnapshot(options: {
		preserveDesired: boolean;
		clearOnNotReady: boolean;
	}): Promise<void> {
		const projectPath = this.projectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		const generation = this.contextGeneration;
		if (!projectPath || !effectiveProjectKey) return;
		try {
			const snapshot = await getGitWorkbenchSnapshot(projectPath, 'unstaged', 0, {
				bodyCandidateCount: 1,
			});
			if (
				generation !== this.contextGeneration ||
				effectiveProjectKey !== this.effectiveProjectKey
			) {
				return;
			}
			if (snapshot.status !== 'ready') {
				if (options.clearOnNotReady) {
					this.tree = [];
					this.intents = {};
				}
				this.lastError = snapshot.message;
				return;
			}
			this.applyTree(snapshot.tree.root, options.preserveDesired);
			this.lastError = null;
		} catch (error) {
			if (
				generation === this.contextGeneration &&
				effectiveProjectKey === this.effectiveProjectKey
			) {
				this.lastError = m.quick_git_load_failed_detail({
					detail: error instanceof Error ? error.message : String(error),
				});
			}
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
			this.refreshTreeSnapshot(),
			this.deps.refreshSummary?.() ?? Promise.resolve(),
		]);
	}

	private startRefreshAfterMutation(): void {
		void this.refreshAfterMutation().catch((error) => {
			this.lastError = m.quick_git_refresh_failed_detail({
				detail: error instanceof Error ? error.message : String(error),
			});
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

	private enqueueStageIntent(path: string, desiredSelected: boolean, forceStage = false): boolean {
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

	private reconcilePathsAfterStage(paths: string[], desiredSelected: boolean): void {
		const result = reconcileTreeAfterStage(this.tree, new Set(paths), desiredSelected);
		if (result.changed) this.tree = result.nodes;
	}

	private markQueueActive(): void {
		if (this.queueSettledPromise) return;
		this.queueSettledPromise = new Promise((resolve) => {
			this.resolveQueueSettled = resolve;
		});
	}

	private markQueueSettled(): void {
		if (!this.queueSettledPromise || this.hasPendingStageOperations || this.queue.length > 0)
			return;
		this.resolveQueueSettled?.();
		this.queueSettledPromise = null;
		this.resolveQueueSettled = null;
	}

	private resetForContext(effectiveProjectKey: string | null, projectPath: string | null): void {
		this.contextGeneration += 1;
		this.resolveQueueSettled?.();
		this.effectiveProjectKey = effectiveProjectKey;
		this.projectPath = projectPath;
		this.tree = [];
		this.intents = {};
		this.queue = [];
		this.forcedStagePaths = new Set();
		this.queueSettledPromise = null;
		this.resolveQueueSettled = null;
		this.shouldRefreshAfterDrain = false;
		this.activationPromise = null;
		this.treeLoadState = 'initial-loading';
		this.isProcessingQueue = false;
		this.isGeneratingMessage = false;
		this.isCommitting = false;
		this.preparingAction = null;
		this.lastError = null;
		this.message = '';
	}

	private async activate(): Promise<void> {
		if (!this.projectPath || !this.effectiveProjectKey || this.disposed) return;
		if (this.activationPromise) return this.activationPromise;
		const generation = this.contextGeneration;
		const activation = (async () => {
			await this.deps.refreshSummary?.();
			if (generation !== this.contextGeneration) return;
			if (this.tree.length === 0) await this.loadInitialTree();
			else await this.refreshTreeSnapshot();
		})();
		const trackedActivation = activation.finally(() => {
			if (this.activationPromise === trackedActivation) this.activationPromise = null;
		});
		this.activationPromise = trackedActivation;
		return trackedActivation;
	}

	private saveCurrentSnapshot(): void {
		const key = this.effectiveProjectKey;
		const projectPath = this.projectPath;
		if (!key || !projectPath) return;
		this.snapshots.delete(key);
		this.snapshots.set(key, {
			projectPath,
			tree: this.tree,
			intents: this.intents,
			message: this.message,
			accessedAt: Date.now(),
		});
		this.pruneSnapshots();
	}

	private restoreSnapshot(key: string): void {
		const snapshot = this.snapshots.get(key);
		if (!snapshot) return;
		this.snapshots.delete(key);
		this.snapshots.set(key, { ...snapshot, accessedAt: Date.now() });
		this.tree = snapshot.tree;
		this.intents = snapshot.intents;
		this.message = snapshot.message;
	}

	private pruneSnapshots(): void {
		while (this.snapshots.size > 8) {
			const cleanEntry = [...this.snapshots.entries()].find(
				([key, snapshot]) => key !== this.effectiveProjectKey && !snapshot.message.trim(),
			);
			if (!cleanEntry) return;
			this.snapshots.delete(cleanEntry[0]);
		}
	}

	private commitMessageGenerationErrorMessage(error: unknown): string {
		if (!(error instanceof ApiError)) {
			return m.quick_git_generate_failed_detail({
				detail: error instanceof Error ? error.message : String(error),
			});
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
