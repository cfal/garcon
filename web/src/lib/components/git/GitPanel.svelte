<script lang="ts">
	// Thin rendering shell for the git source-control panel. Delegates
	// the changes view to GitWorkbench and history to GitHistoryView.
	// Owns the unified top toolbar, branch operations, confirmation
	// modals, and revert flow. Creates the workbench store and passes
	// it down so the toolbar can access commit/review state.

	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import * as m from '$lib/paraglide/messages.js';
	import GitTopToolbar from './GitTopToolbar.svelte';
	import GitWorkbench from './GitWorkbench.svelte';
	import GitHistoryView from './GitHistoryView.svelte';
	import GitCommitModal from './GitCommitModal.svelte';
	import NewBranchModal from './NewBranchModal.svelte';
	import GitConfirmModal from './GitConfirmModal.svelte';
	import GitPushModal from './GitPushModal.svelte';
	import CommitMessageSettingsModal from './CommitMessageSettingsModal.svelte';
	import GitRevertModal from './GitRevertModal.svelte';
	import { GitPanelStore } from '$lib/stores/git-panel.svelte.js';
	import { GitWorkbenchStore } from '$lib/stores/git-workbench.svelte.js';
	import { getPreferences } from '$lib/context';

	interface GitPanelProps {
		projectPath: string | null;
		isMobile: boolean;
		onSendToChat?: (message: string) => Promise<boolean>;
	}

	let { projectPath, isMobile, onSendToChat }: GitPanelProps = $props();

	const preferences = getPreferences();
	const store = new GitPanelStore({
		get provider() { return preferences.selectedProvider; },
	});
	const wb = new GitWorkbenchStore({
		get provider() { return preferences.selectedProvider; },
	});
	let gitDiffFontSize = $derived(parseInt(preferences.gitDiffFontSize, 10) || 12);

	// Commit modal state
	let showCommitModal = $state(false);
	let showCommitSettings = $state(false);

	// Revert UI state (lives here since revert is a history-mode action)
	let showRevertModal = $state(false);
	let revertStrategy = $state<'revert' | 'reset-soft'>('revert');

	// Derived: whether push is available
	let canPush = $derived(
		!!store.remoteStatus?.hasRemote && (
			!store.remoteStatus.hasUpstream ||
			store.remoteStatus.ahead > 0
		)
	);

	// Reset and fetch when the project path changes.
	$effect(() => {
		store.resetForProject(projectPath);
	});

	// Fetch history when switching to the history tab.
	$effect(() => {
		if (projectPath && store.activeView === 'history') {
			store.fetchRecentCommits(projectPath);
		}
	});

	function handleRefresh(): void {
		if (!projectPath) return;
		store.refreshAll(projectPath);
		wb.refreshAllData();
		wb.loadTree(projectPath);
	}

	async function handleCommitFromModal(): Promise<void> {
		if (!projectPath) return;
		const ok = await wb.commitIndex(projectPath);
		if (ok) showCommitModal = false;
	}

	function handleGenerateMessage(): void {
		if (!projectPath) return;
		wb.generateCommitMsg(projectPath);
	}

	async function handleRevert(): Promise<void> {
		if (!projectPath) return;
		await wb.revertLastCommit(projectPath, revertStrategy);
		showRevertModal = false;
	}
</script>

{#if !projectPath}
	<div class="h-full flex items-center justify-center text-muted-foreground">
		<p>{m.git_panel_select_project()}</p>
	</div>
{:else}
	<div class="h-full flex flex-col bg-background">
		<GitTopToolbar
			{isMobile}
			activeView={store.activeView}
			currentBranch={store.currentBranch}
			branches={store.branches}
			remoteStatus={store.remoteStatus}
			showBranchDropdown={store.showBranchDropdown}
			isLoading={store.isLoading || wb.isLoadingTree}
			isPushing={store.isPushing}
			reviewCount={wb.reviewComments.length}
			canCommit={wb.stagedFiles.length > 0}
			isCommitting={wb.isCommitting}
			{canPush}
			diffMode={wb.diffMode}
			contextLines={wb.contextLines}
			diffFontSize={preferences.gitDiffFontSize}
			onToggleBranchDropdown={() => (store.showBranchDropdown = !store.showBranchDropdown)}
			onCloseBranchDropdown={() => (store.showBranchDropdown = false)}
			onShowNewBranchModal={() => (store.showNewBranchModal = true)}
			onSwitchBranch={(branch) => store.handleSwitchBranch(projectPath, branch)}
			onViewCommits={() => (store.activeView = 'history')}
			onViewChanges={() => (store.activeView = 'changes')}
			onOpenReview={() => (wb.reviewModalOpen = true)}
			onCommit={() => { showCommitModal = true; }}
			onPush={() => store.handleToolbarPush(projectPath)}
			onSetDiffMode={(m) => wb.setDiffMode(m)}
			onSetContextLines={(n) => wb.setContextLines(n)}
			onSetDiffFontSize={(size) => preferences.setPreference('gitDiffFontSize', size)}
			onOpenCommitSettings={() => { showCommitSettings = true; }}
			onRevert={() => {
				revertStrategy = 'revert';
				showRevertModal = true;
			}}
			onRefresh={handleRefresh}
		/>

		{#if store.gitStatus?.error}
			<div class="flex-1 flex flex-col items-center justify-center text-muted-foreground px-6 py-12">
				<GitBranchIcon class="w-20 h-20 mb-6 opacity-30" />
				<h3 class="text-xl font-medium mb-3 text-center">{store.gitStatus.error}</h3>
				{#if store.gitStatus.details}
					<p class="text-sm text-center leading-relaxed mb-6 max-w-md">{store.gitStatus.details}</p>
				{/if}
				<div class="p-4 bg-status-info rounded-lg border border-status-info-border max-w-md">
					<p class="text-sm text-status-info-foreground text-center">
						<strong>{m.git_panel_tip()}</strong> {m.git_panel_init_repo()}
					</p>
				</div>
			</div>
			{:else}
				{#if store.activeView === 'changes'}
					<GitWorkbench
						projectPath={projectPath}
						{isMobile}
						{wb}
						{onSendToChat}
						diffFontSize={gitDiffFontSize}
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
					onToggleCommitExpanded={(hash) => store.toggleCommitExpanded(projectPath, hash)}
				/>
			{/if}
		{/if}

		{#if store.showNewBranchModal}
			<NewBranchModal
				currentBranch={store.currentBranch}
				newBranchName={store.newBranchName}
				isCreatingBranch={store.isCreatingBranch}
				onNameChange={(name) => (store.newBranchName = name)}
				onCreateBranch={() => store.handleCreateBranch(projectPath)}
				onClose={() => (store.showNewBranchModal = false)}
			/>
		{/if}

		{#if store.confirmAction}
			<GitConfirmModal
				confirmAction={store.confirmAction}
				onConfirm={() => store.confirmAndExecute(projectPath)}
				onCancel={() => (store.confirmAction = null)}
			/>
		{/if}

		{#if showRevertModal}
			<GitRevertModal
				strategy={revertStrategy}
				onStrategyChange={(strategy) => { revertStrategy = strategy; }}
				onConfirm={handleRevert}
				onCancel={() => { showRevertModal = false; }}
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
				onMessageChange={(msg) => { wb.commitMessage = msg; }}
				onCommit={handleCommitFromModal}
				onGenerate={handleGenerateMessage}
				onClose={() => { showCommitModal = false; }}
			/>
		{/if}

		{#if store.showPushModal}
			<GitPushModal
				remotes={store.pushRemotes}
				currentBranch={store.currentBranch}
				isPushing={store.isPushing}
				onPush={(remote, remoteBranch) => store.handlePush(projectPath, remote, remoteBranch)}
				onClose={() => { store.showPushModal = false; }}
			/>
		{/if}

		{#if showCommitSettings}
			<CommitMessageSettingsModal
				onClose={() => { showCommitSettings = false; }}
				onSettingsChanged={(s) => {
					wb.commitGenerationEnabled = s.enabled;
					wb.commitProvider = s.provider;
					wb.commitModel = s.model;
					wb.commitCustomPrompt = s.customPrompt;
					wb.commitUseCommonDirPrefix = s.useCommonDirPrefix;
				}}
			/>
		{/if}
	</div>
{/if}
