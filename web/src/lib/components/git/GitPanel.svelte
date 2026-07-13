<script lang="ts">
	// Thin rendering shell for the git source-control panel. Delegates
	// the changes view to GitWorkbench and history to GitHistoryView.
	// Owns the unified top toolbar, branch operations, confirmation
	// modals, and revert flow. Creates the workbench store and passes
	// it down so the toolbar can access commit/review state.

	import { onDestroy, untrack } from 'svelte';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import GitTopToolbar from './GitTopToolbar.svelte';
	import GitWorkbench from './GitWorkbench.svelte';
	import GitFreshnessBanner from './GitFreshnessBanner.svelte';
	import GitHistoryView from './GitHistoryView.svelte';
	import GitCommitModal from './GitCommitModal.svelte';
	import GitConfirmModal from './GitConfirmModal.svelte';
	import GitPushModal from './GitPushModal.svelte';
	import GitRevertModal from './GitRevertModal.svelte';
	import GitTargetDialog from './GitTargetDialog.svelte';
	import { startGitFreshnessPolling } from './git-freshness-polling';
	import type { GitWorkbenchTarget } from '$lib/stores/git-workbench.svelte.js';
	import { gitProjectInvalidations } from '$lib/stores/git-project-invalidation.svelte';
	import { togglePinnedProjectPathOptimistically } from '$lib/chat/pinned-project-path-settings.js';
	import type {
		GitHistoryRevertTarget,
		GitHistoryScreen,
	} from '$lib/stores/git/git-history.svelte';
	import { getGitTargetCandidates, type GitTargetCandidate } from '$lib/api/git.js';
	import {
		getLocalSettings,
		getFileSessions,
		getRemoteSettings,
		getTransientLayers,
		getSingletonSurfaces,
	} from '$lib/context';

	interface GitPanelProps {
		chatId: string | null;
		projectPath: string | null;
		effectiveProjectKey?: string | null;
		isMobile: boolean;
		isVisible?: boolean;
		onSendToChat?: (message: string) => Promise<boolean>;
	}

	let {
		chatId,
		projectPath,
		effectiveProjectKey = null,
		isMobile,
		isVisible = true,
		onSendToChat,
	}: GitPanelProps = $props();

	const localSettings = getLocalSettings();
	const fileSessions = getFileSessions();
	const remoteSettings = getRemoteSettings();
	const transientLayers = getTransientLayers();
	const gitSurface = getSingletonSurfaces().git();
	const store = gitSurface.panel;
	const wb = gitSurface.workbench;
	let presentationVisible = $derived(isVisible && gitSurface.presentationVisible);
	let files = $derived(wb.files);
	let review = $derived(wb.review);
	let commit = $derived(wb.commit);
	let drafts = $derived(wb.drafts);
	let gitDiffFontSize = $derived(parseInt(localSettings.gitDiffFontSize, 10) || 12);
	let targets = $state<GitTargetCandidate[]>([]);
	let activeTarget = $state<GitWorkbenchTarget | null>(null);
	let loadedProjectKey = $state<string | null>(null);
	let lastTargetFetchKey = $state<string | null>(null);
	let isLoadingTargets = $state(false);
	let showTargetDialog = $state(false);
	let targetRequestGeneration = 0;
	let targetRequestAbort: AbortController | null = null;
	let fallbackTarget = $derived<GitWorkbenchTarget | null>(
		projectPath
			? {
					projectPath,
					repoRoot: projectPath,
					worktreePath: projectPath,
					label: projectPath.split('/').pop() || projectPath,
					branch: '',
					source: 'chat-project',
				}
			: null,
	);
	let activeProjectPath = $derived(activeTarget?.projectPath ?? projectPath);
	let activeWorktreePath = $derived((activeTarget ?? fallbackTarget)?.worktreePath ?? null);
	let projectBasePath = $derived(remoteSettings.snapshot?.projectBasePath ?? projectPath ?? '/');
	let pinnedProjectPaths = $derived(remoteSettings.snapshot?.paths.pinnedProjectPaths ?? []);

	// Commit modal state
	let showCommitModal = $state(false);

	// Revert UI state lives here so history screens stay presentational.
	let showRevertModal = $state(false);
	let pendingRevertCommit = $state<GitHistoryRevertTarget | null>(null);
	let isRevertingCommit = $state(false);
	let historyScreen = $state<GitHistoryScreen>('list');
	let historyRefreshToken = $state(0);

	// Derived: whether push is available
	let canPush = $derived(
		!!store.remoteStatus?.hasRemote &&
			(!store.remoteStatus.hasUpstream || store.remoteStatus.ahead > 0),
	);
	let showTopToolbar = $derived(!(store.activeView === 'history' && historyScreen === 'commit'));

	function toWorkbenchTarget(candidate: GitTargetCandidate): GitWorkbenchTarget {
		return {
			projectPath: candidate.projectPath,
			repoRoot: candidate.repoRoot,
			worktreePath: candidate.worktreePath,
			label: candidate.label,
			branch: candidate.branch,
			source: candidate.source,
		};
	}

	async function refreshTargets(
		baseProjectPath: string,
		fallback: GitWorkbenchTarget | null,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		isLoadingTargets = true;
		try {
			const result = await getGitTargetCandidates(baseProjectPath, { signal });
			if (!isCurrentTargetRequest(generation, signal)) return;
			targets = result.targets;
			const current =
				result.targets.find((candidate) => candidate.isCurrent && !candidate.isMissing) ??
				result.targets.find((candidate) => !candidate.isMissing) ??
				null;
			if (
				!activeTarget ||
				!result.targets.some(
					(candidate) =>
						candidate.worktreePath === activeTarget?.worktreePath && !candidate.isMissing,
				)
			) {
				activeTarget = current ? toWorkbenchTarget(current) : fallback;
			}
		} catch (err) {
			if (isAbortError(err) || !isCurrentTargetRequest(generation, signal)) return;
			wb.reportError(
				`Failed to load Git targets: ${err instanceof Error ? err.message : String(err)}`,
			);
			targets = fallback
				? [
						{
							projectPath: fallback.projectPath,
							repoRoot: fallback.repoRoot,
							worktreePath: fallback.worktreePath,
							label: fallback.label,
							branch: '',
							source: fallback.source,
							isCurrent: true,
							isMissing: false,
						},
					]
				: [];
			activeTarget = fallback;
		} finally {
			if (isCurrentTargetRequest(generation, signal)) isLoadingTargets = false;
		}
	}

	function startTargetRefresh(baseProjectPath: string, fallback: GitWorkbenchTarget | null): void {
		targetRequestAbort?.abort();
		const controller = new AbortController();
		targetRequestAbort = controller;
		const generation = ++targetRequestGeneration;
		void refreshTargets(baseProjectPath, fallback, generation, controller.signal);
	}

	function isCurrentTargetRequest(generation: number, signal: AbortSignal): boolean {
		return !signal.aborted && generation === targetRequestGeneration;
	}

	function isAbortError(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'name' in error &&
			(error as { name?: unknown }).name === 'AbortError'
		);
	}

	$effect(() => {
		untrack(() => {
			void remoteSettings.ensureLoadedInBackground();
		});
	});

	// Reset and fetch when the chat project changes.
	$effect(() => {
		const baseProjectPath = projectPath;
		const projectKey = effectiveProjectKey ?? baseProjectPath;
		const fallback = fallbackTarget;
		const visible = presentationVisible;
		untrack(() => {
			const targetLoadWasPending = isLoadingTargets;
			targetRequestAbort?.abort();
			targetRequestAbort = null;
			targetRequestGeneration += 1;
			isLoadingTargets = false;
			if (!baseProjectPath || !projectKey) {
				targets = [];
				activeTarget = null;
				loadedProjectKey = null;
				lastTargetFetchKey = null;
				isLoadingTargets = false;
				store.resetForProject(null);
				void wb.setTarget(null);
				return;
			}
			if (loadedProjectKey !== projectKey) {
				loadedProjectKey = projectKey;
				activeTarget = fallback;
			} else if (!activeTarget && fallback) {
				activeTarget = fallback;
			}
			if (!visible) {
				if (targetLoadWasPending) lastTargetFetchKey = null;
				return;
			}
			if (lastTargetFetchKey === projectKey) return;
			lastTargetFetchKey = projectKey;
			startTargetRefresh(baseProjectPath, fallback);
		});
	});

	$effect(() => {
		if (!presentationVisible) return;
		const nextTarget = activeTarget ?? fallbackTarget;
		const metadataProjectPath = nextTarget?.projectPath ?? activeProjectPath;
		store.resetForProject(metadataProjectPath, {
			deferMetadata: true,
			currentBranch: nextTarget?.branch,
		});
		untrack(() => void wb.setTarget(nextTarget));
		if (metadataProjectPath) {
			untrack(() => {
				void store.fetchRemoteStatus(metadataProjectPath);
			});
		}
	});

	$effect(() => {
		const activeView = store.activeView;
		untrack(() => {
			if (activeView !== 'history') historyScreen = 'list';
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

	let lastProjectInvalidationKey = '';
	$effect(() => {
		if (!presentationVisible) return;
		const projectToRefresh = activeProjectPath;
		const invalidationKey = effectiveProjectKey ?? projectToRefresh;
		const version = gitProjectInvalidations.version(invalidationKey);
		if (!projectToRefresh) return;
		const key = `${invalidationKey}:${version}`;
		if (key === lastProjectInvalidationKey) return;
		lastProjectInvalidationKey = key;
		if (version === 0) return;
		untrack(() => {
			void wb.refresh({
				reason: 'git-action',
				preserveSelection: true,
				preferSelectedFile: true,
			});
			store.refreshDeferredMetadata(projectToRefresh);
		});
	});

	onDestroy(() => {
		targetRequestAbort?.abort();
	});

	async function handleRefresh(): Promise<void> {
		if (!activeProjectPath) return;
		const nextTarget = activeTarget ?? fallbackTarget;
		if (!nextTarget) {
			await wb.setTarget(null);
			return;
		}
		const shouldRefreshExistingTarget = wb.hasTarget;
		store.refreshDeferredMetadata(activeProjectPath);
		await wb.setTarget(nextTarget);
		if (shouldRefreshExistingTarget) await wb.refresh({ reason: 'manual' });
		startTargetRefresh(activeProjectPath, nextTarget);
	}

	async function handleStaleRefresh(): Promise<void> {
		if (!activeProjectPath) return;
		store.refreshDeferredMetadata(activeProjectPath);
		await wb.refreshStaleWorkbench();
		startTargetRefresh(activeProjectPath, activeTarget ?? fallbackTarget);
	}

	async function runPanelGitMutation<T>(
		action: (projectToMutate: string) => Promise<T>,
	): Promise<T | null> {
		const projectToMutate = activeProjectPath;
		if (!projectToMutate) return null;
		if (!wb.ensureFreshForGitMutation()) return null;
		return wb.runLocalGitMutation(projectToMutate, () => action(projectToMutate));
	}

	async function handleCommitFromModal(): Promise<void> {
		if (!activeProjectPath) return;
		const ok = await commit.commitIndex(activeProjectPath);
		if (ok) showCommitModal = false;
		if (ok) store.refreshAll(activeProjectPath);
	}

	function handleGenerateMessage(): void {
		if (!activeProjectPath) return;
		commit.generateCommitMsg(activeProjectPath);
	}

	async function handleRevert(): Promise<void> {
		const target = pendingRevertCommit;
		if (!activeProjectPath || !target || isRevertingCommit) return;
		isRevertingCommit = true;
		try {
			const ok = await commit.revertCommit(activeProjectPath, target.hash);
			if (!ok) return;
			store.refreshAll(activeProjectPath);
			historyRefreshToken += 1;
			showRevertModal = false;
			pendingRevertCommit = null;
		} finally {
			isRevertingCommit = false;
		}
	}

	function requestRevertCommit(commit: GitHistoryRevertTarget): void {
		transientLayers.open('main-inert', () => {
			pendingRevertCommit = commit;
			showRevertModal = true;
		});
	}

	async function handleOpenPush(): Promise<void> {
		const projectToPush = activeProjectPath;
		if (!projectToPush || !(await store.prepareToolbarPush(projectToPush))) return;
		if (activeProjectPath !== projectToPush) return;
		transientLayers.open('main-inert', () => {
			store.showPushModal = true;
		});
	}

	function handleOpenInEditor(relativePath: string, line: number): void {
		if (!activeProjectPath) return;
		void fileSessions.open({
			chatId: chatId ?? undefined,
			fileRootPath: activeProjectPath,
			relativePath,
			mode: 'code',
			reason: 'user-open',
			line,
		});
	}

	function handleTargetConfirm(candidate: GitTargetCandidate): void {
		const nextTarget = toWorkbenchTarget(candidate);
		activeTarget = nextTarget;
		targets = [
			candidate,
			...targets.filter((target) => target.worktreePath !== candidate.worktreePath),
		];
		startTargetRefresh(nextTarget.projectPath, nextTarget);
		showTargetDialog = false;
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
				activeView={store.activeView}
				currentBranch={store.currentBranch}
				refs={store.refs}
				remoteStatus={store.remoteStatus}
				{targets}
				{activeWorktreePath}
				{isLoadingTargets}
				showBranchDropdown={store.showBranchDropdown}
				isLoadingBranches={store.isLoadingBranches}
				isLoading={store.isLoading || files.isLoadingTree}
				isPushing={store.isPushing}
				reviewCount={drafts.reviewComments.length}
				canCommit={files.stagedFiles.length > 0}
				isCommitting={commit.isCommitting}
				{canPush}
				diffMode={review.diffMode}
				contextLines={review.contextLines}
				diffFontSize={localSettings.gitDiffFontSize}
				onToggleBranchDropdown={() => {
					if (!activeProjectPath) return;
					if (store.showBranchDropdown) {
						store.showBranchDropdown = false;
						return;
					}
					void store.openBranchDropdown(activeProjectPath);
				}}
				onCloseBranchDropdown={() => (store.showBranchDropdown = false)}
				onShowNewBranchModal={() => {
					if (activeProjectPath) store.openNewBranchDialog(activeProjectPath);
				}}
				onSearchRefs={(query) => {
					if (!activeProjectPath) return;
					void store.fetchRefs(activeProjectPath, query);
				}}
				onSwitchBranch={async (branch, refKind) => {
					await runPanelGitMutation(async (projectToMutate) => {
						const ok = await store.handleSwitchBranch(projectToMutate, branch, refKind);
						if (ok) await wb.refresh({ reason: 'branch-change', preserveSelection: false });
						return ok;
					});
				}}
				onOpenWorktrees={() => {
					transientLayers.open('main-inert', () => {
						showTargetDialog = true;
					});
				}}
				onViewCommits={() => (store.activeView = 'history')}
				onViewChanges={() => (store.activeView = 'changes')}
				onOpenReview={() => {
					transientLayers.open('main-inert', () => {
						drafts.reviewModalOpen = true;
					});
				}}
				onCommit={() => {
					transientLayers.open('main-inert', () => {
						showCommitModal = true;
					});
				}}
				onPush={() => void handleOpenPush()}
				onSetDiffMode={(mode) => {
					review.diffMode = mode;
				}}
				onSetContextLines={(n) => wb.setContextLines(n)}
				onSetDiffFontSize={(size) => localSettings.set('gitDiffFontSize', size)}
				onRefresh={handleRefresh}
			/>
		{/if}

		{#if store.lastError || wb.lastError}
			<div
				class="flex items-center gap-2 border-b border-status-error-border bg-status-error/10 px-3 py-1.5 text-xs text-status-error-foreground"
			>
				<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
				<span class="min-w-0 flex-1 truncate">{store.lastError ?? wb.lastError}</span>
				<button
					type="button"
					class="rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					aria-label={m.git_action_dismiss_error()}
					onclick={() => {
						store.dismissError();
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

		{#if store.activeView === 'changes'}
			<GitWorkbench
				target={activeTarget ?? fallbackTarget}
				{isMobile}
				{wb}
				{onSendToChat}
				diffFontSize={gitDiffFontSize}
				onOpenInEditor={handleOpenInEditor}
			/>
		{/if}

		{#if store.activeView === 'history'}
			<GitHistoryView
				projectPath={activeProjectPath}
				{isMobile}
				diffMode={review.diffMode}
				contextLines={review.contextLines}
				diffFontSize={gitDiffFontSize}
				refreshToken={historyRefreshToken}
				onScreenChange={(screen) => {
					historyScreen = screen;
				}}
				onRevertCommit={requestRevertCommit}
				onOpenInEditor={handleOpenInEditor}
			/>
		{/if}

		{#if store.confirmAction}
			<GitConfirmModal
				confirmAction={store.confirmAction}
				onConfirm={async () => {
					await runPanelGitMutation(async (projectToMutate) => {
						const ok = await store.confirmAndExecute(projectToMutate);
						if (ok) await wb.refresh({ reason: 'git-action' });
						return ok;
					});
				}}
				onCancel={() => (store.confirmAction = null)}
			/>
		{/if}

		{#if showRevertModal && pendingRevertCommit}
			<GitRevertModal
				commitShortHash={pendingRevertCommit.shortHash}
				commitSubject={pendingRevertCommit.subject}
				isReverting={isRevertingCommit}
				onConfirm={handleRevert}
				onCancel={() => {
					if (isRevertingCommit) return;
					showRevertModal = false;
					pendingRevertCommit = null;
				}}
			/>
		{/if}

		{#if showCommitModal}
			<GitCommitModal
				stagedFiles={files.stagedFileNodes}
				commitMessage={commit.commitMessage}
				isCommitting={commit.isCommitting}
				isGeneratingMessage={commit.isGeneratingMessage}
				{isMobile}
				onMessageChange={(msg) => {
					commit.commitMessage = msg;
				}}
				onCommit={handleCommitFromModal}
				onGenerate={handleGenerateMessage}
				onClose={() => {
					showCommitModal = false;
				}}
			/>
		{/if}

		{#if store.showPushModal}
			<GitPushModal
				remotes={store.pushRemotes}
				currentBranch={store.currentBranch}
				isPushing={store.isPushing}
				onPush={async (remote) => {
					await runPanelGitMutation(async (projectToMutate) => {
						const ok = await store.handlePush(projectToMutate, remote);
						if (ok) await wb.refresh({ reason: 'git-action' });
						return ok;
					});
				}}
				onClose={() => {
					store.showPushModal = false;
				}}
			/>
		{/if}

		{#if showTargetDialog && activeProjectPath}
			<GitTargetDialog
				initialPath={activeProjectPath}
				{projectBasePath}
				{pinnedProjectPaths}
				{isMobile}
				onConfirm={handleTargetConfirm}
				onTogglePinnedProjectPath={togglePinnedProjectPath}
				onClose={() => {
					showTargetDialog = false;
				}}
			/>
		{/if}
	</div>
{/if}
