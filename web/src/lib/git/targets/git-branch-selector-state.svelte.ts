import { getGitRefs, gitCheckoutRef, gitCreateBranch, type GitRefOption } from '$lib/api/git.js';
import {
	persistGitBranchSortPreference,
	readGitBranchSortPreference,
} from '$lib/git/targets/git-branch-sort-preference.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import {
	DEFAULT_GIT_REF_SORT,
	GIT_REF_RESULT_LIMITS,
	type GitRefSort,
	type GitRefSortKey,
} from '$shared/git-refs';

export type GitBranchMutation = 'switch' | 'create';

export interface GitBranchSelectorStateOptions {
	runMutation?: (
		surfaceId: string,
		projectPath: string,
		effectiveProjectKey: string,
		execute: () => Promise<{ success: boolean; error?: string }>,
	) => Promise<{ success: boolean; error?: string }>;
	onMutation?: (
		projectPath: string,
		mutation: GitBranchMutation,
		effectiveProjectKey: string,
	) => void | Promise<void>;
	surfaceError?: (message: string) => void;
	openMainInert?: (commitOpen: () => void) => void;
}

export class GitBranchSelectorState {
	currentProjectPath = $state<string | null>(null);
	currentEffectiveProjectKey = $state<string | null>(null);
	currentBranch = $state('');
	refs = $state<GitRefOption[]>([]);
	branchSort = $state<GitRefSort>(readGitBranchSortPreference());
	isLoadingBranches = $state(false);
	showBranchDropdown = $state(false);
	showNewBranchModal = $state(false);
	newBranchName = $state('');
	newBranchBaseRef = $state('');
	newBranchRefs = $state<GitRefOption[]>([]);
	newBranchCurrentBranch = $state('');
	newBranchProjectPath = $state<string | null>(null);
	newBranchEffectiveProjectKey = $state<string | null>(null);
	newBranchSurfaceId = $state<string | null>(null);
	isLoadingNewBranchRefs = $state(false);
	isCreatingBranch = $state(false);
	lastError = $state<string | null>(null);

	private branchLoadGeneration = 0;
	private newBranchLoadGeneration = 0;
	private newBranchInvocationGeneration = 0;
	private projectContextGeneration = 0;
	private errorClearTimeout: ReturnType<typeof setTimeout> | null = null;
	private branchRefsAbort: AbortController | null = null;
	private newBranchRefsAbort: AbortController | null = null;

	constructor(private readonly options: GitBranchSelectorStateOptions = {}) {}

	get branches(): string[] {
		return this.refs.map((ref) => ref.name);
	}

	set branches(value: string[]) {
		this.refs = value.map((branch) => ({
			name: branch,
			ref: branch,
			kind: 'local-branch',
			updatedAt: null,
			isCurrent: branch === this.currentBranch,
		}));
	}

	setProject(
		projectPath: string | null,
		currentBranch?: string,
		effectiveProjectKey: string | null = projectPath,
	): void {
		if (effectiveProjectKey !== this.currentEffectiveProjectKey) {
			this.resetForProject(projectPath, currentBranch ?? '', effectiveProjectKey);
			return;
		}
		this.currentProjectPath = projectPath;
		if (currentBranch !== undefined && currentBranch !== this.currentBranch) {
			this.currentBranch = currentBranch;
		}
	}

	resetForProject(
		projectPath: string | null,
		currentBranch = '',
		effectiveProjectKey: string | null = projectPath,
	): void {
		this.projectContextGeneration += 1;
		this.cancelBranchLoad();
		this.closeNewBranchDialog();
		this.currentProjectPath = projectPath;
		this.currentEffectiveProjectKey = effectiveProjectKey;
		this.currentBranch = currentBranch;
		this.refs = [];
		this.isLoadingBranches = false;
		this.showBranchDropdown = false;
		this.lastError = null;
	}

	closeBranchDropdown(): void {
		this.showBranchDropdown = false;
		this.cancelBranchLoad();
	}

	openNewBranchDialog(projectPath: string, surfaceId: string, effectiveProjectKey: string): void {
		this.cancelNewBranchLoad();
		const generation = ++this.newBranchInvocationGeneration;
		this.newBranchProjectPath = projectPath;
		this.newBranchEffectiveProjectKey = effectiveProjectKey;
		this.newBranchSurfaceId = surfaceId;
		this.newBranchCurrentBranch = this.currentBranch;
		this.newBranchName = '';
		this.newBranchBaseRef = '';
		this.newBranchRefs = [];
		const open = () => {
			if (generation !== this.newBranchInvocationGeneration) return;
			this.showNewBranchModal = true;
		};
		if (this.options.openMainInert) this.options.openMainInert(open);
		else open();
		void this.searchNewBranchRefs('');
	}

	closeNewBranchDialog(): void {
		this.newBranchInvocationGeneration += 1;
		this.cancelNewBranchLoad();
		this.showNewBranchModal = false;
		this.newBranchName = '';
		this.newBranchBaseRef = '';
		this.newBranchRefs = [];
		this.newBranchCurrentBranch = '';
		this.newBranchProjectPath = null;
		this.newBranchEffectiveProjectKey = null;
		this.newBranchSurfaceId = null;
		this.isLoadingNewBranchRefs = false;
		this.isCreatingBranch = false;
	}

	async openBranchDropdown(projectPath: string): Promise<void> {
		this.showBranchDropdown = true;
		await this.searchBranchRefs(projectPath);
	}

	async fetchRefs(projectPath: string, query = ''): Promise<void> {
		await this.loadRefs(projectPath, query, DEFAULT_GIT_REF_SORT);
	}

	async searchBranchRefs(projectPath: string, query = ''): Promise<void> {
		await this.loadRefs(projectPath, query, this.branchSort);
	}

	async toggleBranchSort(projectPath: string, key: GitRefSortKey, query = ''): Promise<void> {
		const direction =
			this.branchSort.key === key
				? this.branchSort.direction === 'asc'
					? 'desc'
					: 'asc'
				: key === 'updated'
					? 'desc'
					: 'asc';
		this.branchSort = { key, direction };
		persistGitBranchSortPreference(this.branchSort);
		await this.searchBranchRefs(projectPath, query);
	}

	private async loadRefs(projectPath: string, query: string, sort: GitRefSort): Promise<void> {
		this.branchRefsAbort?.abort();
		const controller = new AbortController();
		this.branchRefsAbort = controller;
		const generation = ++this.branchLoadGeneration;
		this.isLoadingBranches = true;
		try {
			const data = await getGitRefs(projectPath, {
				query,
				limit: GIT_REF_RESULT_LIMITS.default,
				sort,
				signal: controller.signal,
			});
			if (controller.signal.aborted || generation !== this.branchLoadGeneration) return;
			if (data.error) {
				this.refs = [];
				this.surfaceError(data.error);
				return;
			}
			this.refs = data.refs ?? [];
			if (!query) {
				const current = this.refs.find((ref) => ref.isCurrent);
				if (current) this.currentBranch = current.name;
			}
		} catch (err) {
			if (
				controller.signal.aborted ||
				isAbortError(err) ||
				generation !== this.branchLoadGeneration
			)
				return;
			this.refs = [];
			this.surfaceError(`Load refs failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (this.branchRefsAbort === controller) this.branchRefsAbort = null;
			if (generation === this.branchLoadGeneration) {
				this.isLoadingBranches = false;
			}
		}
	}

	async searchNewBranchRefs(query: string): Promise<void> {
		const projectPath = this.newBranchProjectPath;
		const invocationGeneration = this.newBranchInvocationGeneration;
		if (!projectPath) return;
		this.newBranchRefsAbort?.abort();
		const controller = new AbortController();
		this.newBranchRefsAbort = controller;
		const generation = ++this.newBranchLoadGeneration;
		this.isLoadingNewBranchRefs = true;
		try {
			const data = await getGitRefs(projectPath, {
				query,
				limit: GIT_REF_RESULT_LIMITS.default,
				sort: DEFAULT_GIT_REF_SORT,
				signal: controller.signal,
			});
			if (
				controller.signal.aborted ||
				generation !== this.newBranchLoadGeneration ||
				invocationGeneration !== this.newBranchInvocationGeneration
			)
				return;
			if (data.error) {
				this.newBranchRefs = [];
				this.surfaceError(data.error);
				return;
			}
			this.newBranchRefs = data.refs ?? [];
		} catch (err) {
			if (
				controller.signal.aborted ||
				isAbortError(err) ||
				generation !== this.newBranchLoadGeneration ||
				invocationGeneration !== this.newBranchInvocationGeneration
			)
				return;
			this.newBranchRefs = [];
			this.surfaceError(`Load refs failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (this.newBranchRefsAbort === controller) this.newBranchRefsAbort = null;
			if (
				generation === this.newBranchLoadGeneration &&
				invocationGeneration === this.newBranchInvocationGeneration
			) {
				this.isLoadingNewBranchRefs = false;
			}
		}
	}

	async checkoutRef(
		projectPath: string,
		refOption: GitRefOption,
		surfaceId: string,
		effectiveProjectKey: string,
	): Promise<boolean> {
		const projectContextGeneration = this.projectContextGeneration;
		try {
			const execute = () => gitCheckoutRef(projectPath, refOption.ref, refOption.kind);
			const data = this.options.runMutation
				? await this.options.runMutation(surfaceId, projectPath, effectiveProjectKey, execute)
				: await execute();
			if (data.success) {
				if (
					projectContextGeneration === this.projectContextGeneration &&
					this.currentProjectPath === projectPath &&
					this.currentEffectiveProjectKey === effectiveProjectKey
				) {
					this.currentBranch = refOption.name;
					this.closeBranchDropdown();
					await this.searchBranchRefs(projectPath);
				}
				await this.options.onMutation?.(projectPath, 'switch', effectiveProjectKey);
				return true;
			}
			this.surfaceError(data.error ?? 'Checkout ref failed');
			return false;
		} catch (err) {
			this.surfaceError(`Checkout ref failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async switchBranch(
		projectPath: string,
		branch: string,
		refKind: GitRefOption['kind'] | undefined,
		surfaceId: string,
		effectiveProjectKey: string,
	): Promise<boolean> {
		const refOption = this.refs.find((ref) => ref.ref === branch || ref.name === branch) ?? {
			name: branch,
			ref: branch,
			kind: refKind ?? ('local-branch' as const),
			updatedAt: null,
		};
		return this.checkoutRef(projectPath, refOption, surfaceId, effectiveProjectKey);
	}

	async createBranch(): Promise<boolean> {
		const projectPath = this.newBranchProjectPath;
		const effectiveProjectKey = this.newBranchEffectiveProjectKey;
		const surfaceId = this.newBranchSurfaceId;
		const invocationGeneration = this.newBranchInvocationGeneration;
		const projectContextGeneration = this.projectContextGeneration;
		if (!projectPath || !effectiveProjectKey || !surfaceId) return false;
		const branch = this.newBranchName.trim();
		if (!branch) return false;
		const baseRef = this.newBranchBaseRef.trim() || undefined;

		this.isCreatingBranch = true;
		try {
			const execute = () => gitCreateBranch(projectPath, branch, { baseRef });
			const data = this.options.runMutation
				? await this.options.runMutation(surfaceId, projectPath, effectiveProjectKey, execute)
				: await execute();
			if (data.success) {
				if (
					projectContextGeneration === this.projectContextGeneration &&
					this.currentProjectPath === projectPath &&
					this.currentEffectiveProjectKey === effectiveProjectKey
				) {
					this.currentBranch = branch;
					await this.searchBranchRefs(projectPath);
				}
				if (
					projectContextGeneration === this.projectContextGeneration &&
					invocationGeneration === this.newBranchInvocationGeneration
				) {
					this.showBranchDropdown = false;
					this.closeNewBranchDialog();
				}
				await this.options.onMutation?.(projectPath, 'create', effectiveProjectKey);
				return true;
			}
			this.surfaceError(data.error ?? 'Create branch failed');
			return false;
		} catch (err) {
			this.surfaceError(
				`Create branch failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		} finally {
			if (invocationGeneration === this.newBranchInvocationGeneration) {
				this.isCreatingBranch = false;
			}
		}
	}

	destroy(): void {
		this.closeBranchDropdown();
		this.closeNewBranchDialog();
		if (this.errorClearTimeout) {
			clearTimeout(this.errorClearTimeout);
			this.errorClearTimeout = null;
		}
	}

	private cancelBranchLoad(): void {
		this.branchRefsAbort?.abort();
		this.branchRefsAbort = null;
		this.branchLoadGeneration += 1;
		this.isLoadingBranches = false;
	}

	private cancelNewBranchLoad(): void {
		this.newBranchRefsAbort?.abort();
		this.newBranchRefsAbort = null;
		this.newBranchLoadGeneration += 1;
		this.isLoadingNewBranchRefs = false;
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
