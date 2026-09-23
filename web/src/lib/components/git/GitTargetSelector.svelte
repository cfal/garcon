<script lang="ts">
	import GitBranchSelector from './GitBranchSelector.svelte';
	import GitProjectSelector from './GitProjectSelector.svelte';
	import NewBranchModal from './NewBranchModal.svelte';
	import type { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';

	let {
		target,
		isMobile,
	}: {
		target: GitTargetSessionController;
		isMobile: boolean;
	} = $props();
	const branchDisabled = $derived(!target.canChangeTarget);

	function toggleBranchSelector(): void {
		const projectPath = target.activeProjectPath;
		if (branchDisabled || !projectPath) return;
		if (target.branches.showBranchDropdown) {
			target.branches.closeBranchDropdown();
			return;
		}
		void target.branches.openBranchDropdown(projectPath);
	}
</script>

<GitProjectSelector
	selection={target.projectSelection}
	path={target.activeWorktreePath ?? target.activeProjectPath}
	disabled={!target.canChooseProject}
	{isMobile}
	onSelectNode={(nodeId) => void target.selectNode(nodeId)}
	onSelectFolder={(candidate) => void target.selectTarget(candidate)}
	onGoToChatProject={() => target.goToChatProject()}
>
	<GitBranchSelector
		currentBranch={target.branches.currentBranch || 'HEAD'}
		refs={target.branches.refs}
		sort={target.branches.branchSort}
		isOpen={target.branches.showBranchDropdown}
		isLoading={target.branches.isLoadingBranches}
		disabled={branchDisabled}
		{isMobile}
		triggerClass="h-8 min-w-26 max-w-40 px-2 text-xs sm:max-w-80"
		iconClass="shrink-0"
		chevronClass="shrink-0"
		labelClass="min-w-0 max-w-24 text-xs"
		onToggle={toggleBranchSelector}
		onClose={() => target.branches.closeBranchDropdown()}
		onCreateBranch={() => target.openNewBranchDialog()}
		onSwitchBranch={(branch, refKind) => void target.switchBranch(branch, refKind)}
		onSearchRefs={(query) => {
			if (target.activeProjectPath) {
				return target.branches.searchBranchRefs(target.activeProjectPath, query);
			}
		}}
		onSortRefs={(key, query) => {
			if (target.activeProjectPath) {
				return target.branches.toggleBranchSort(target.activeProjectPath, key, query);
			}
		}}
	/>
</GitProjectSelector>

{#if target.branches.showNewBranchModal}
	<NewBranchModal
		currentBranch={target.branches.newBranchCurrentBranch || 'HEAD'}
		newBranchName={target.branches.newBranchName}
		refOptions={target.branches.newBranchRefs}
		selectedBaseRef={target.branches.newBranchBaseRef}
		isLoadingRefs={target.branches.isLoadingNewBranchRefs}
		isCreatingBranch={target.branches.isCreatingBranch}
		onNameChange={(name) => (target.branches.newBranchName = name)}
		onBaseRefChange={(ref) => (target.branches.newBranchBaseRef = ref)}
		onSearchRefs={(query) => void target.branches.searchNewBranchRefs(query)}
		onCreateBranch={() => void target.createBranch()}
		onClose={() => target.branches.closeNewBranchDialog()}
	/>
{/if}
