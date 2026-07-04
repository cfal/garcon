import {
	getGitRefs,
	gitCheckoutRef,
	gitCreateBranch,
	type GitRefOption,
} from '$lib/api/git.js';

export type GitBranchMutation = 'switch' | 'create';
const REF_RESULT_LIMIT = 200;

interface GitBranchSelectorStateOptions {
	onMutation?: (projectPath: string, mutation: GitBranchMutation) => void | Promise<void>;
	surfaceError?: (message: string) => void;
}

export class GitBranchSelectorState {
	currentProjectPath = $state<string | null>(null);
	currentBranch = $state('');
	refs = $state<GitRefOption[]>([]);
	isLoadingBranches = $state(false);
	showBranchDropdown = $state(false);
	showNewBranchModal = $state(false);
	newBranchName = $state('');
	newBranchBaseRef = $state('');
	isCreatingBranch = $state(false);
	lastError = $state<string | null>(null);

	private branchLoadGeneration = 0;
	private errorClearTimeout: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: GitBranchSelectorStateOptions = {}) {}

	get branches(): string[] {
		return this.refs.map((ref) => ref.name);
	}

	set branches(value: string[]) {
		this.refs = value.map((branch) => ({
			name: branch,
			ref: branch,
			kind: 'local-branch',
			isCurrent: branch === this.currentBranch,
		}));
	}

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
		this.refs = [];
		this.isLoadingBranches = false;
		this.showBranchDropdown = false;
		this.showNewBranchModal = false;
		this.newBranchName = '';
		this.newBranchBaseRef = '';
		this.isCreatingBranch = false;
		this.lastError = null;
	}

	closeBranchDropdown(): void {
		this.showBranchDropdown = false;
	}

	async openBranchDropdown(projectPath: string): Promise<void> {
		this.showBranchDropdown = true;
		if (!this.isLoadingBranches) await this.fetchRefs(projectPath);
	}

	async fetchRefs(projectPath: string, query = ''): Promise<void> {
		const generation = ++this.branchLoadGeneration;
		this.isLoadingBranches = true;
		try {
			const data = await getGitRefs(projectPath, { query, limit: REF_RESULT_LIMIT });
			if (generation !== this.branchLoadGeneration) return;
			if (data.error) {
				this.refs = [];
				this.surfaceError(data.error);
				return;
			}
			this.refs = data.refs ?? [];
		} catch (err) {
			if (generation !== this.branchLoadGeneration) return;
			this.refs = [];
			this.surfaceError(`Load refs failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (generation === this.branchLoadGeneration) {
				this.isLoadingBranches = false;
			}
		}
	}

	async fetchBranches(projectPath: string): Promise<void> {
		await this.fetchRefs(projectPath);
	}

	async checkoutRef(projectPath: string, refOption: GitRefOption): Promise<boolean> {
		try {
			const data = await gitCheckoutRef(projectPath, refOption.ref);
			if (data.success) {
				this.currentBranch = refOption.name;
				this.showBranchDropdown = false;
				await this.fetchRefs(projectPath);
				await this.options.onMutation?.(projectPath, 'switch');
				return true;
			}
			this.surfaceError(data.error ?? 'Checkout ref failed');
			return false;
		} catch (err) {
			this.surfaceError(`Checkout ref failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async switchBranch(projectPath: string, branch: string): Promise<boolean> {
		const refOption =
			this.refs.find((ref) => ref.ref === branch || ref.name === branch) ??
			{ name: branch, ref: branch, kind: 'local-branch' as const };
		return this.checkoutRef(projectPath, refOption);
	}

	async createBranch(projectPath: string): Promise<boolean> {
		const branch = this.newBranchName.trim();
		if (!branch) return false;
		const baseRef = this.newBranchBaseRef.trim() || undefined;

		this.isCreatingBranch = true;
		try {
			const data = await gitCreateBranch(projectPath, branch, { baseRef });
			if (data.success) {
				this.currentBranch = branch;
				this.showNewBranchModal = false;
				this.showBranchDropdown = false;
				this.newBranchName = '';
				this.newBranchBaseRef = '';
				await this.fetchRefs(projectPath);
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
