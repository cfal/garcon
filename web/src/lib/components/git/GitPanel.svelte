<script lang="ts">
	// Thin rendering shell for the git source-control panel. Delegates
	// the changes view to GitWorkbench and history to GitHistoryView.
	// Owns the unified top toolbar, branch operations, confirmation
	// modals, and revert flow. Creates the workbench store and passes
	// it down so the toolbar can access commit/review state.

	import { untrack } from 'svelte';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import GitTopToolbar from './GitTopToolbar.svelte';
	import GitWorkbench from './GitWorkbench.svelte';
	import GitFreshnessBanner from './GitFreshnessBanner.svelte';
	import GitHistoryView from './GitHistoryView.svelte';
	import GitCommitModal from './GitCommitModal.svelte';
	import NewBranchModal from './NewBranchModal.svelte';
	import GitConfirmModal from './GitConfirmModal.svelte';
	import GitPushModal from './GitPushModal.svelte';
	import CommitMessageSettingsModal from './CommitMessageSettingsModal.svelte';
	import GitRevertModal from './GitRevertModal.svelte';
	import GitTargetDialog from './GitTargetDialog.svelte';
	import { startGitFreshnessPolling } from './git-freshness-polling';
	import { GitPanelStore } from '$lib/stores/git-panel.svelte.js';
	import { GitWorkbenchStore, type GitWorkbenchTarget } from '$lib/stores/git-workbench.svelte.js';
	import { getGitTargetCandidates, type GitTargetCandidate } from '$lib/api/git.js';
	import { getLocalSettings, getFileViewer, getRemoteSettings } from '$lib/context';

	interface GitPanelProps {
		chatId: string;
		projectPath: string | null;
		isMobile: boolean;
		onSendToChat?: (message: string) => Promise<boolean>;
	}

	let { chatId, projectPath, isMobile, onSendToChat }: GitPanelProps = $props();

	const localSettings = getLocalSettings();
	const fileViewer = getFileViewer();
	const remoteSettings = getRemoteSettings();
	const store = new GitPanelStore();
	const wb = new GitWorkbenchStore({
		getSettings: async () => {
			const snap = await remoteSettings.ensureLoaded();
			return {
				ui: snap.ui as Record<string, unknown>,
				uiEffective: snap.uiEffective as Record<string, unknown>,
			};
		},
		remoteSnapshot: () => {
			const snap = remoteSettings.snapshot;
			if (!snap) return null;
			return {
				ui: snap.ui as Record<string, unknown>,
				uiEffective: snap.uiEffective as Record<string, unknown>,
			};
		},
	});
	let gitDiffFontSize = $derived(parseInt(localSettings.gitDiffFontSize, 10) || 12);
	let targets = $state<GitTargetCandidate[]>([]);
	let activeTarget = $state<GitWorkbenchTarget | null>(null);
	let loadedProjectPath = $state<string | null>(null);
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

	// Commit modal state
	let showCommitModal = $state(false);
	let showCommitSettings = $state(false);

	// Revert UI state (lives here since revert is a history-mode action)
	let showRevertModal = $state(false);
	let revertStrategy = $state<'revert' | 'reset-soft'>('revert');

	// Derived: whether push is available
	let canPush = $derived(
		!!store.remoteStatus?.hasRemote &&
			(!store.remoteStatus.hasUpstream || store.remoteStatus.ahead > 0),
	);

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
		const fallback = fallbackTarget;
		untrack(() => {
			targetRequestAbort?.abort();
			targetRequestAbort = null;
			targetRequestGeneration += 1;
			if (!baseProjectPath) {
				targets = [];
				activeTarget = null;
				loadedProjectPath = null;
				isLoadingTargets = false;
				store.resetForProject(null);
				void wb.setTarget(null);
				return;
			}
			if (loadedProjectPath !== baseProjectPath) {
				loadedProjectPath = baseProjectPath;
				activeTarget = fallback;
			} else if (!activeTarget && fallback) {
				activeTarget = fallback;
			}
			startTargetRefresh(baseProjectPath, fallback);
		});
	});

	$effect(() => {
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
		const nextTarget = activeTarget ?? fallbackTarget;
		if (!nextTarget) return;
		return startGitFreshnessPolling({
			projectPath: nextTarget.projectPath,
			checkFreshness: (projectToCheck) => {
				untrack(() => void wb.checkFreshness(projectToCheck));
			},
		});
	});

	// Fetch history when switching to the history tab.
	$effect(() => {
		if (activeProjectPath && store.activeView === 'history') {
			store.fetchRecentCommits(activeProjectPath);
		}
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
		const ok = await wb.commitIndex(activeProjectPath);
		if (ok) showCommitModal = false;
		if (ok) store.refreshAll(activeProjectPath);
	}

	function handleGenerateMessage(): void {
		if (!activeProjectPath) return;
		wb.generateCommitMsg(activeProjectPath);
	}

	async function handleRevert(): Promise<void> {
		if (!activeProjectPath) return;
		await wb.revertLastCommit(activeProjectPath, revertStrategy);
		store.refreshAll(activeProjectPath);
		showRevertModal = false;
	}

	function handleOpenInEditor(relativePath: string, line: number): void {
		if (!activeProjectPath) return;
		fileViewer.openCode({
			chatId,
			projectPath: activeProjectPath,
			relativePath,
			source: 'command',
			line,
		});
	}

	function handleTargetConfirm(candidate: GitTargetCandidate): void {
		const nextTarget = toWorkbenchTarget(candidate);
		activeTarget = nextTarget;
		targets = [candidate, ...targets.filter((target) => target.worktreePath !== candidate.worktreePath)];
		startTargetRefresh(nextTarget.projectPath, nextTarget);
		showTargetDialog = false;
	}
</script>

{#if !activeProjectPath}
	<div class="h-full flex items-center justify-center text-muted-foreground">
		<p>{m.git_panel_select_project()}</p>
	</div>
{:else}
	<div class="relative h-full flex flex-col bg-background">
		<GitTopToolbar
			{isMobile}
			activeView={store.activeView}
			currentBranch={store.currentBranch}
			branches={store.branches}
			remoteStatus={store.remoteStatus}
			{targets}
			{activeWorktreePath}
			{isLoadingTargets}
			showBranchDropdown={store.showBranchDropdown}
			isLoading={store.isLoading || wb.isLoadingTree}
			isPushing={store.isPushing}
			reviewCount={wb.reviewComments.length}
			canCommit={wb.stagedFiles.length > 0}
			isCommitting={wb.isCommitting}
			{canPush}
			diffMode={wb.diffMode}
			contextLines={wb.contextLines}
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
			onShowNewBranchModal={() => (store.showNewBranchModal = true)}
			onSwitchBranch={async (branch) => {
				await runPanelGitMutation(async (projectToMutate) => {
					const ok = await store.handleSwitchBranch(projectToMutate, branch);
					if (ok) await wb.refresh({ reason: 'branch-change', preserveSelection: false });
					return ok;
				});
			}}
			onOpenWorktrees={() => {
				showTargetDialog = true;
			}}
			onViewCommits={() => (store.activeView = 'history')}
			onViewChanges={() => (store.activeView = 'changes')}
			onOpenReview={() => (wb.reviewModalOpen = true)}
			onCommit={() => {
				showCommitModal = true;
			}}
			onPush={() => {
				if (activeProjectPath) store.handleToolbarPush(activeProjectPath);
			}}
			onSetDiffMode={(m) => wb.setDiffMode(m)}
			onSetContextLines={(n) => wb.setContextLines(n)}
			onSetDiffFontSize={(size) => localSettings.set('gitDiffFontSize', size)}
			onOpenCommitSettings={() => {
				showCommitSettings = true;
			}}
			onRevert={() => {
				revertStrategy = 'revert';
				showRevertModal = true;
			}}
			onRefresh={handleRefresh}
		/>

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
			<GitFreshnessBanner isRefreshing={wb.isLoadingTree} onRefresh={handleStaleRefresh} />
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

		{#if store.activeView === 'history' && !store.gitStatus?.error}
			<GitHistoryView
				{isMobile}
				isLoading={store.isLoading}
				recentCommits={store.recentCommits}
				expandedCommits={store.expandedCommits}
				commitDiffs={store.commitDiffs}
				wrapText={store.wrapText}
				onToggleCommitExpanded={(hash) => {
					if (activeProjectPath) store.toggleCommitExpanded(activeProjectPath, hash);
				}}
			/>
		{/if}

		{#if store.showNewBranchModal}
			<NewBranchModal
				currentBranch={store.currentBranch}
				newBranchName={store.newBranchName}
				isCreatingBranch={store.isCreatingBranch}
				onNameChange={(name) => (store.newBranchName = name)}
				onCreateBranch={async () => {
					await runPanelGitMutation(async (projectToMutate) => {
						const ok = await store.handleCreateBranch(projectToMutate);
						if (ok) await wb.refresh({ reason: 'branch-change', preserveSelection: false });
						return ok;
					});
				}}
				onClose={() => (store.showNewBranchModal = false)}
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

		{#if showRevertModal}
			<GitRevertModal
				strategy={revertStrategy}
				onStrategyChange={(strategy) => {
					revertStrategy = strategy;
				}}
				onConfirm={handleRevert}
				onCancel={() => {
					showRevertModal = false;
				}}
			/>
		{/if}

		{#if showCommitModal}
			<GitCommitModal
				stagedFiles={wb.stagedFileNodes}
				commitMessage={wb.commitMessage}
				isCommitting={wb.isCommitting}
				isGeneratingMessage={wb.isGeneratingMessage}
				canGenerate={wb.commitGenerationEnabled}
				commonDirPrefix={wb.commonDirPrefix}
				{isMobile}
				onMessageChange={(msg) => {
					wb.commitMessage = msg;
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
				onPush={async (remote, remoteBranch) => {
					await runPanelGitMutation(async (projectToMutate) => {
						const ok = await store.handlePush(projectToMutate, remote, remoteBranch);
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
				{isMobile}
				onConfirm={handleTargetConfirm}
				onClose={() => {
					showTargetDialog = false;
				}}
			/>
		{/if}

		{#if showCommitSettings}
			<CommitMessageSettingsModal
				onClose={() => {
					showCommitSettings = false;
				}}
				onSettingsChanged={(s) => {
					wb.commitGenerationEnabled = s.enabled;
					wb.commitAgentId = s.agentId;
					wb.commitModel = s.model;
					wb.commitApiProviderId = s.apiProviderId ?? null;
					wb.commitModelEndpointId = s.modelEndpointId ?? null;
					wb.commitModelProtocol = s.modelProtocol ?? null;
					wb.commitCustomPrompt = s.customPrompt;
					wb.commitUseCommonDirPrefix = s.useCommonDirPrefix;
				}}
			/>
		{/if}
	</div>
{/if}
