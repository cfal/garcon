<script lang="ts">
	// Renders the root-owned Git surface controller for the active placement.

	import { untrack } from 'svelte';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import GitTopToolbar from './GitTopToolbar.svelte';
	import GitWorkbench from './GitWorkbench.svelte';
	import GitFreshnessBanner from './GitFreshnessBanner.svelte';
	import GitHistoryView from './GitHistoryView.svelte';
	import GitConfirmModal from './GitConfirmModal.svelte';
	import GitPushModal from './GitPushModal.svelte';
	import GitRevertModal from './GitRevertModal.svelte';
	import GitTargetDialog from './GitTargetDialog.svelte';
	import { startGitFreshnessPolling } from './git-freshness-polling';
	import { gitProjectInvalidations } from '$lib/git/surface/git-project-invalidation.svelte.js';
	import { togglePinnedProjectPathOptimistically } from '$lib/chat/project-paths/pinned-project-path-settings.js';
	import type { GitHistoryRevertTarget } from '$lib/git/history/git-history.svelte.js';
	import type { GitTargetCandidate } from '$lib/api/git.js';
	import type { HostId } from '$lib/workspace/surface-types.js';
	import {
		getLocalSettings,
		getFileSessions,
		getRemoteSettings,
		getTransientLayers,
		getSingletonSurfaces,
		getWorkspaceCoordinator,
	} from '$lib/context';

	interface GitPanelProps {
		projectPath: string | null;
		effectiveProjectKey?: string | null;
		isMobile: boolean;
		presentation: HostId | 'mobile';
		isVisible?: boolean;
		onSendToChat?: (message: string) => Promise<boolean>;
	}

	let {
		projectPath,
		effectiveProjectKey = null,
		isMobile,
		presentation,
		isVisible = true,
		onSendToChat,
	}: GitPanelProps = $props();

	const localSettings = getLocalSettings();
	const fileSessions = getFileSessions();
	const remoteSettings = getRemoteSettings();
	const transientLayers = getTransientLayers();
	const workspace = getWorkspaceCoordinator();
	const gitSurface = getSingletonSurfaces().git();
	const repository = gitSurface.repository;
	const wb = gitSurface.workbench;
	const history = gitSurface.history;
	let presentationVisible = $derived(
		isVisible && gitSurface.presentationVisible && !gitSurface.projectIdentityPending,
	);
	let files = $derived(wb.files);
	let review = $derived(wb.review);
	let commit = $derived(wb.commit);
	let drafts = $derived(wb.drafts);
	let gitDiffFontSize = $derived(parseInt(localSettings.gitDiffFontSize, 10) || 12);
	let targets = $derived(gitSurface.targets);
	let activeTarget = $derived(gitSurface.activeTarget);
	let isLoadingTargets = $derived(gitSurface.isLoadingTargets);
	let fallbackTarget = $derived(gitSurface.fallbackTarget);
	let activeProjectPath = $derived(gitSurface.activeProjectPath);
	let activeWorktreePath = $derived(gitSurface.activeWorktreePath);
	let projectBasePath = $derived(remoteSettings.snapshot?.projectBasePath ?? projectPath ?? '/');
	let pinnedProjectPaths = $derived(remoteSettings.snapshot?.paths.pinnedProjectPaths ?? []);

	// Derived: whether push is available
	let canPush = $derived(
		!!repository.remoteStatus?.hasRemote &&
			(!repository.remoteStatus.hasUpstream || repository.remoteStatus.ahead > 0),
	);
	let showTopToolbar = $derived(
		!(repository.activeView === 'history' && history.screen === 'commit'),
	);

	$effect(() => {
		untrack(() => {
			void remoteSettings.ensureLoadedInBackground();
		});
	});

	$effect(() => {
		if (!presentationVisible) return;
		const nextTarget = activeTarget ?? fallbackTarget;
		if (!nextTarget) return;
		return startGitFreshnessPolling({
			projectPath: nextTarget.projectPath,
			checkFreshness: (projectToCheck) => {
				untrack(() => void wb.checkFreshness(projectToCheck));
			},
		});
	});

	$effect(() => {
		if (!presentationVisible) return;
		const projectToRefresh = activeProjectPath;
		if (!projectToRefresh) return;
		const invalidationKey = effectiveProjectKey ?? projectToRefresh;
		const version = gitProjectInvalidations.version(invalidationKey);
		if (!gitSurface.takeInvalidationRefresh(invalidationKey, version)) return;
		untrack(() => {
			void wb.refresh({
				reason: 'git-action',
				preserveSelection: true,
				preferSelectedFile: true,
			});
			repository.refreshDeferredMetadata(projectToRefresh);
		});
	});

	async function handleRefresh(): Promise<void> {
		if (!activeProjectPath) return;
		const nextTarget = activeTarget ?? fallbackTarget;
		if (!nextTarget) {
			await wb.setTarget(null);
			return;
		}
		const shouldRefreshExistingTarget = wb.hasTarget;
		repository.refreshDeferredMetadata(activeProjectPath);
		await wb.setTarget(nextTarget);
		if (shouldRefreshExistingTarget) await wb.refresh({ reason: 'manual' });
		await gitSurface.ensureTargets(true);
	}

	async function handleStaleRefresh(): Promise<void> {
		if (!activeProjectPath) return;
		repository.refreshDeferredMetadata(activeProjectPath);
		await wb.refreshStaleWorkbench();
		await gitSurface.ensureTargets(true);
	}

	async function runPanelGitMutation<T>(
		action: (projectToMutate: string) => Promise<T>,
	): Promise<T | null> {
		const projectToMutate = activeProjectPath;
		if (!projectToMutate) return null;
		if (!wb.ensureFreshForGitMutation()) return null;
		return wb.runLocalGitMutation(projectToMutate, () => action(projectToMutate));
	}

	function handleOpenCommit(): void {
		if (isMobile) {
			void workspace.focusMobileSingleton('commit');
			return;
		}
		void workspace.openSingleton('commit', 'sidebar');
	}

	function handleViewCommits(): void {
		repository.activeView = 'history';
	}

	function handleViewChanges(): void {
		history.backToList();
		repository.activeView = 'changes';
	}

	async function handleRevert(): Promise<void> {
		const target = gitSurface.pendingRevertCommit;
		const projectToRevert = activeProjectPath;
		if (!projectToRevert || !target || gitSurface.isRevertingCommit) return;
		gitSurface.isRevertingCommit = true;
		try {
			const ok = await commit.revertCommit(projectToRevert, target.hash);
			if (!ok || activeProjectPath !== projectToRevert) return;
			repository.refreshAll(projectToRevert);
			gitSurface.historyRefreshToken += 1;
			gitSurface.showRevertModal = false;
			gitSurface.pendingRevertCommit = null;
		} finally {
			if (activeProjectPath === projectToRevert) gitSurface.isRevertingCommit = false;
		}
	}

	function requestRevertCommit(commit: GitHistoryRevertTarget): void {
		transientLayers.open('main-inert', () => {
			gitSurface.pendingRevertCommit = commit;
			gitSurface.showRevertModal = true;
		});
	}

	async function handleOpenPush(): Promise<void> {
		const projectToPush = activeProjectPath;
		if (!projectToPush || !(await repository.prepareToolbarPush(projectToPush))) return;
		if (activeProjectPath !== projectToPush) return;
		transientLayers.open('main-inert', () => {
			repository.showPushModal = true;
		});
	}

	function handleOpenInEditor(relativePath: string, line: number): void {
		if (!activeProjectPath) return;
		void fileSessions.open({
			fileRootPath: activeProjectPath,
			relativePath,
			mode: 'code',
			origin: presentation,
			reason: 'user-open',
			line,
		});
	}

	function handleTargetConfirm(candidate: GitTargetCandidate): void {
		void gitSurface.selectTarget(candidate);
	}

	async function togglePinnedProjectPath(path: string): Promise<void> {
		await togglePinnedProjectPathOptimistically(remoteSettings, path);
	}
</script>

{#if !activeProjectPath}
	<div class="h-full flex items-center justify-center text-muted-foreground">
		<p>{m.git_panel_select_project()}</p>
	</div>
{:else}
	<div class="relative h-full flex flex-col bg-background">
		{#if showTopToolbar}
			<GitTopToolbar
				{isMobile}
				activeView={repository.activeView}
				currentBranch={repository.currentBranch}
				refs={repository.refs}
				remoteStatus={repository.remoteStatus}
				{targets}
				{activeWorktreePath}
				{isLoadingTargets}
				showBranchDropdown={repository.showBranchDropdown}
				isLoadingBranches={repository.isLoadingBranches}
				isLoading={repository.isLoading || files.isLoadingTree}
				isPushing={repository.isPushing}
				reviewCount={drafts.reviewComments.length}
				isCommitting={commit.isCommitting}
				{canPush}
				diffMode={review.diffMode}
				contextLines={review.contextLines}
				diffFontSize={localSettings.gitDiffFontSize}
				onToggleBranchDropdown={() => {
					if (!activeProjectPath) return;
					if (repository.showBranchDropdown) {
						repository.showBranchDropdown = false;
						return;
					}
					void repository.openBranchDropdown(activeProjectPath);
				}}
				onCloseBranchDropdown={() => (repository.showBranchDropdown = false)}
				onShowNewBranchModal={() => {
					if (activeProjectPath && effectiveProjectKey) {
						repository.openNewBranchDialog(activeProjectPath, effectiveProjectKey);
					}
				}}
				onSearchRefs={(query) => {
					if (!activeProjectPath) return;
					void repository.fetchRefs(activeProjectPath, query);
				}}
				onSwitchBranch={async (branch, refKind) => {
					await runPanelGitMutation(async (projectToMutate) => {
						const ok = await repository.handleSwitchBranch(
							projectToMutate,
							branch,
							refKind,
							effectiveProjectKey ?? projectToMutate,
						);
						if (ok) await wb.refresh({ reason: 'branch-change', preserveSelection: false });
						return ok;
					});
				}}
				onOpenWorktrees={() => {
					transientLayers.open('main-inert', () => {
						gitSurface.showTargetDialog = true;
					});
				}}
				onViewCommits={handleViewCommits}
				onViewChanges={handleViewChanges}
				onOpenReview={() => {
					transientLayers.open('main-inert', () => {
						drafts.reviewModalOpen = true;
					});
				}}
				onCommit={handleOpenCommit}
				onPush={() => void handleOpenPush()}
				onSetDiffMode={(mode) => {
					review.diffMode = mode;
				}}
				onSetContextLines={(n) => wb.setContextLines(n)}
				onSetDiffFontSize={(size) => localSettings.set('gitDiffFontSize', size)}
				onRefresh={handleRefresh}
			/>
		{/if}

		{#if repository.lastError || wb.lastError}
			<div
				class="flex items-center gap-2 border-b border-status-error-border bg-status-error/10 px-3 py-1.5 text-xs text-status-error-foreground"
			>
				<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
				<span class="min-w-0 flex-1 truncate">{repository.lastError ?? wb.lastError}</span>
				<button
					type="button"
					class="rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					aria-label={m.git_action_dismiss_error()}
					onclick={() => {
						repository.dismissError();
						wb.dismissError();
					}}
				>
					<X class="h-3.5 w-3.5" />
				</button>
			</div>
		{/if}

		{#if wb.isExternallyStale}
			<GitFreshnessBanner isRefreshing={files.isLoadingTree} onRefresh={handleStaleRefresh} />
		{/if}

		{#if repository.activeView === 'changes'}
			<GitWorkbench
				target={activeTarget ?? fallbackTarget}
				{isMobile}
				{wb}
				{onSendToChat}
				diffFontSize={gitDiffFontSize}
				onOpenInEditor={handleOpenInEditor}
			/>
		{/if}

		{#if repository.activeView === 'history'}
			<GitHistoryView
				{history}
				projectPath={activeProjectPath}
				{effectiveProjectKey}
				{isMobile}
				diffMode={review.diffMode}
				contextLines={review.contextLines}
				diffFontSize={gitDiffFontSize}
				refreshToken={gitSurface.historyRefreshToken}
				onRevertCommit={requestRevertCommit}
				onOpenInEditor={handleOpenInEditor}
			/>
		{/if}

		{#if repository.confirmAction}
			<GitConfirmModal
				confirmAction={repository.confirmAction}
				onConfirm={async () => {
					await runPanelGitMutation(async (projectToMutate) => {
						const ok = await repository.confirmAndExecute(projectToMutate);
						if (ok) await wb.refresh({ reason: 'git-action' });
						return ok;
					});
				}}
				onCancel={() => (repository.confirmAction = null)}
			/>
		{/if}

		{#if gitSurface.showRevertModal && gitSurface.pendingRevertCommit}
			<GitRevertModal
				commitShortHash={gitSurface.pendingRevertCommit.shortHash}
				commitSubject={gitSurface.pendingRevertCommit.subject}
				isReverting={gitSurface.isRevertingCommit}
				onConfirm={handleRevert}
				onCancel={() => {
					if (gitSurface.isRevertingCommit) return;
					gitSurface.showRevertModal = false;
					gitSurface.pendingRevertCommit = null;
				}}
			/>
		{/if}

		{#if repository.showPushModal}
			<GitPushModal
				remotes={repository.pushRemotes}
				currentBranch={repository.currentBranch}
				isPushing={repository.isPushing}
				onPush={async (remote) => {
					await runPanelGitMutation(async (projectToMutate) => {
						const ok = await repository.handlePush(projectToMutate, remote);
						if (ok) await wb.refresh({ reason: 'git-action' });
						return ok;
					});
				}}
				onClose={() => {
					repository.showPushModal = false;
				}}
			/>
		{/if}

		{#if gitSurface.showTargetDialog && activeProjectPath}
			<GitTargetDialog
				initialPath={activeProjectPath}
				{projectBasePath}
				{pinnedProjectPaths}
				{isMobile}
				onConfirm={handleTargetConfirm}
				onTogglePinnedProjectPath={togglePinnedProjectPath}
				onClose={() => {
					gitSurface.showTargetDialog = false;
				}}
			/>
		{/if}
	</div>
{/if}
