import {
	getGitBlame,
	getGitCompare,
	getGitConflictDetails,
	getGitConflicts,
	getGitFileHistory,
	getGitGraph,
	getGitStashes,
	gitAcceptConflictSide,
	gitApplyStash,
	gitCreateStash,
	gitDropStash,
	gitMarkConflictResolved,
	gitPopStash,
	type GitBlameLine,
	type GitCompareFile,
	type GitConflictDetails,
	type GitConflictFile,
	type GitFileHistoryEntry,
	type GitGraphCommit,
	type GitStashEntry,
} from '$lib/api/git.js';

export type GitInspectorView = 'none' | 'conflicts' | 'stash' | 'history' | 'graph';

export interface GitPorcelainDeps {
	selectedFile: () => string | null;
	refreshAfterMutation: (projectPath: string) => Promise<void>;
	surfaceError: (message: string) => void;
}

export class GitPorcelainState {
	inspectorView = $state<GitInspectorView>('none');
	isLoading = $state(false);
	conflicts = $state<GitConflictFile[]>([]);
	conflictDetails = $state<GitConflictDetails | null>(null);
	stashes = $state<GitStashEntry[]>([]);
	fileHistory = $state<GitFileHistoryEntry[]>([]);
	blameLines = $state<GitBlameLine[]>([]);
	blameTruncated = $state(false);
	graphCommits = $state<GitGraphCommit[]>([]);
	compareFiles = $state<GitCompareFile[]>([]);
	compareBase = $state('HEAD~1');
	compareHead = $state('HEAD');
	stashMessage = $state('');
	stashIncludeUntracked = $state(false);

	constructor(private readonly deps: GitPorcelainDeps) {}

	setInspectorView(view: GitInspectorView): void {
		this.inspectorView = this.inspectorView === view ? 'none' : view;
	}

	async loadCurrentView(projectPath: string): Promise<void> {
		if (this.inspectorView === 'conflicts') await this.loadConflicts(projectPath);
		else if (this.inspectorView === 'stash') await this.loadStashes(projectPath);
		else if (this.inspectorView === 'history') await this.loadHistory(projectPath);
		else if (this.inspectorView === 'graph') await this.loadGraph(projectPath);
	}

	async loadConflicts(projectPath: string): Promise<void> {
		await this.withLoading('Failed to load conflicts', async () => {
			const result = await getGitConflicts(projectPath);
			this.conflicts = result.conflicts;
			if (this.conflicts.length > 0) {
				this.conflictDetails = await getGitConflictDetails(projectPath, this.conflicts[0].path);
			} else {
				this.conflictDetails = null;
			}
		});
	}

	async selectConflict(projectPath: string, filePath: string): Promise<void> {
		await this.withLoading('Failed to load conflict details', async () => {
			this.conflictDetails = await getGitConflictDetails(projectPath, filePath);
		});
	}

	async acceptConflictSide(projectPath: string, filePath: string, side: 'ours' | 'theirs'): Promise<void> {
		await this.withLoading('Failed to accept conflict side', async () => {
			const result = await gitAcceptConflictSide(projectPath, filePath, side);
			if (result.success) {
				await this.loadConflicts(projectPath);
				await this.deps.refreshAfterMutation(projectPath);
			}
		});
	}

	async markConflictResolved(projectPath: string, filePath: string): Promise<void> {
		await this.withLoading('Failed to mark conflict resolved', async () => {
			const result = await gitMarkConflictResolved(projectPath, filePath);
			if (result.success) {
				await this.loadConflicts(projectPath);
				await this.deps.refreshAfterMutation(projectPath);
			}
		});
	}

	async loadStashes(projectPath: string): Promise<void> {
		await this.withLoading('Failed to load stashes', async () => {
			const result = await getGitStashes(projectPath);
			this.stashes = result.stashes;
		});
	}

	async createStash(projectPath: string): Promise<void> {
		await this.withLoading('Failed to create stash', async () => {
			const result = await gitCreateStash(
				projectPath,
				this.stashMessage,
				this.stashIncludeUntracked,
			);
			if (result.success) {
				this.stashMessage = '';
				await this.loadStashes(projectPath);
				await this.deps.refreshAfterMutation(projectPath);
			}
		});
	}

	async applyStash(projectPath: string, stashRef: string): Promise<void> {
		await this.withLoading('Failed to apply stash', async () => {
			const result = await gitApplyStash(projectPath, stashRef);
			if (result.success) await this.deps.refreshAfterMutation(projectPath);
		});
	}

	async popStash(projectPath: string, stashRef: string): Promise<void> {
		await this.withLoading('Failed to pop stash', async () => {
			const result = await gitPopStash(projectPath, stashRef);
			if (result.success) {
				await this.loadStashes(projectPath);
				await this.deps.refreshAfterMutation(projectPath);
			}
		});
	}

	async dropStash(projectPath: string, stashRef: string): Promise<void> {
		await this.withLoading('Failed to drop stash', async () => {
			const result = await gitDropStash(projectPath, stashRef);
			if (result.success) await this.loadStashes(projectPath);
		});
	}

	async loadHistory(projectPath: string): Promise<void> {
		const filePath = this.deps.selectedFile();
		if (!filePath) {
			this.fileHistory = [];
			this.blameLines = [];
			this.blameTruncated = false;
			return;
		}
		await this.withLoading('Failed to load file history', async () => {
			const [history, blame] = await Promise.all([
				getGitFileHistory(projectPath, filePath),
				getGitBlame(projectPath, filePath, 'HEAD', 300),
			]);
			this.fileHistory = history.commits;
			this.blameLines = blame.lines;
			this.blameTruncated = blame.truncated;
		});
	}

	async loadGraph(projectPath: string): Promise<void> {
		await this.withLoading('Failed to load commit graph', async () => {
			const result = await getGitGraph(projectPath, 200);
			this.graphCommits = result.commits;
		});
	}

	async compareRefs(projectPath: string): Promise<void> {
		await this.withLoading('Failed to compare refs', async () => {
			const result = await getGitCompare(projectPath, this.compareBase, this.compareHead);
			this.compareFiles = result.files;
		});
	}

	reset(): void {
		this.inspectorView = 'none';
		this.isLoading = false;
		this.conflicts = [];
		this.conflictDetails = null;
		this.stashes = [];
		this.fileHistory = [];
		this.blameLines = [];
		this.blameTruncated = false;
		this.graphCommits = [];
		this.compareFiles = [];
		this.compareBase = 'HEAD~1';
		this.compareHead = 'HEAD';
		this.stashMessage = '';
		this.stashIncludeUntracked = false;
	}

	private async withLoading(label: string, action: () => Promise<void>): Promise<void> {
		this.isLoading = true;
		try {
			await action();
		} catch (error) {
			this.deps.surfaceError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.isLoading = false;
		}
	}
}
