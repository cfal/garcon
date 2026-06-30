import {
	getBranches as fetchBranchesApi,
	gitCheckout,
	gitCreateBranch,
} from '$lib/api/git.js';

export type GitBranchMutation = 'switch' | 'create';

interface GitBranchSelectorStateOptions {
	onMutation?: (projectPath: string, mutation: GitBranchMutation) => void | Promise<void>;
	surfaceError?: (message: string) => void;
}

export class GitBranchSelectorState {
	currentProjectPath = $state<string | null>(null);
	currentBranch = $state('');
	branches = $state<string[]>([]);
	isLoadingBranches = $state(false);
	showBranchDropdown = $state(false);
	showNewBranchModal = $state(false);
	newBranchName = $state('');
	isCreatingBranch = $state(false);
	lastError = $state<string | null>(null);

	private branchLoadGeneration = 0;
	private errorClearTimeout: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: GitBranchSelectorStateOptions = {}) {}

	setProject(projectPath: string | null, currentBranch?: string): void {
		if (projectPath !== this.currentProjectPath) {
			this.resetForProject(projectPath, currentBranch ?? '');
			return;
		}
		if (currentBranch !== undefined && currentBranch !== this.currentBranch) {
			this.currentBranch = currentBranch;
		}
	}

	resetForProject(projectPath: string | null, currentBranch = ''): void {
		this.branchLoadGeneration += 1;
		this.currentProjectPath = projectPath;
		this.currentBranch = currentBranch;
		this.branches = [];
		this.isLoadingBranches = false;
		this.showBranchDropdown = false;
		this.showNewBranchModal = false;
		this.newBranchName = '';
		this.isCreatingBranch = false;
		this.lastError = null;
	}

	closeBranchDropdown(): void {
		this.showBranchDropdown = false;
	}

	async openBranchDropdown(projectPath: string): Promise<void> {
		this.showBranchDropdown = true;
		if (this.branches.length === 0 && !this.isLoadingBranches) {
			await this.fetchBranches(projectPath);
		}
	}

	async fetchBranches(projectPath: string): Promise<void> {
		const generation = ++this.branchLoadGeneration;
		this.isLoadingBranches = true;
		try {
			const data = await fetchBranchesApi(projectPath);
			if (generation !== this.branchLoadGeneration) return;
			if (data.error) {
				this.branches = [];
				this.surfaceError(data.error);
				return;
			}
			this.branches = data.branches ?? [];
		} catch (err) {
			if (generation !== this.branchLoadGeneration) return;
			this.branches = [];
			this.surfaceError(`Load branches failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (generation === this.branchLoadGeneration) {
				this.isLoadingBranches = false;
			}
		}
	}

	async switchBranch(projectPath: string, branch: string): Promise<boolean> {
		try {
			const data = await gitCheckout(projectPath, branch);
			if (data.success) {
				this.currentBranch = branch;
				this.showBranchDropdown = false;
				await this.fetchBranches(projectPath);
				await this.options.onMutation?.(projectPath, 'switch');
				return true;
			}
			this.surfaceError(data.error ?? 'Switch branch failed');
			return false;
		} catch (err) {
			this.surfaceError(`Switch branch failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async createBranch(projectPath: string): Promise<boolean> {
		const branch = this.newBranchName.trim();
		if (!branch) return false;

		this.isCreatingBranch = true;
		try {
			const data = await gitCreateBranch(projectPath, branch);
			if (data.success) {
				this.currentBranch = branch;
				this.showNewBranchModal = false;
				this.showBranchDropdown = false;
				this.newBranchName = '';
				await this.fetchBranches(projectPath);
				await this.options.onMutation?.(projectPath, 'create');
				return true;
			}
			this.surfaceError(data.error ?? 'Create branch failed');
			return false;
		} catch (err) {
			this.surfaceError(`Create branch failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			this.isCreatingBranch = false;
		}
	}

	destroy(): void {
		if (this.errorClearTimeout) {
			clearTimeout(this.errorClearTimeout);
			this.errorClearTimeout = null;
		}
	}

	private surfaceError(message: string): void {
		this.lastError = message;
		this.options.surfaceError?.(message);
		if (this.errorClearTimeout) clearTimeout(this.errorClearTimeout);
		this.errorClearTimeout = setTimeout(() => {
			if (this.lastError === message) this.lastError = null;
		}, 6000);
	}
}
