<script lang="ts">
	import Folder from '@lucide/svelte/icons/folder';
	import GitBranchSelector from './GitBranchSelector.svelte';
	import GitTargetDialog from './GitTargetDialog.svelte';
	import NewBranchModal from './NewBranchModal.svelte';
	import type { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
	import {
		getRemoteSettings,
		getTransientLayers,
	} from '$lib/context';
	import { togglePinnedProjectPathOptimistically } from '$lib/chat/project-paths/pinned-project-path-settings.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		target,
		isMobile,
		disabled = false,
	}: {
		target: GitTargetSessionController;
		isMobile: boolean;
		disabled?: boolean;
	} = $props();

	const remoteSettings = getRemoteSettings();
	const transientLayers = getTransientLayers();
	const activePath = $derived(target.activeWorktreePath ?? target.activeProjectPath ?? '');
	const displayPath = $derived(formatFrontEllipsisPath(activePath, isMobile ? 22 : 32));
	const projectBasePath = $derived(
		remoteSettings.snapshot?.projectBasePath ?? target.baseProjectPath ?? '/',
	);
	const pinnedProjectPaths = $derived(
		remoteSettings.snapshot?.paths.pinnedProjectPaths ?? [],
	);

	function openTargetDialog(): void {
		if (disabled || !target.activeProjectPath) return;
		void remoteSettings.ensureLoadedInBackground();
		transientLayers.open('main-inert', () => {
			target.showTargetDialog = true;
		});
	}

	function toggleBranchSelector(): void {
		const projectPath = target.activeProjectPath;
		if (disabled || !projectPath) return;
		if (target.branches.showBranchDropdown) {
			target.branches.closeBranchDropdown();
			return;
		}
		void target.branches.openBranchDropdown(projectPath);
	}

	function formatFrontEllipsisPath(path: string, maxLength: number): string {
		const normalized = path.trim();
		if (!normalized || normalized.length <= maxLength) return normalized;
		const separator = normalized.includes('\\') && !normalized.includes('/') ? '\\' : '/';
		const prefix = normalized.startsWith(separator)
			? `${separator}...${separator}`
			: `...${separator}`;
		const segments = normalized.split(/[\\/]+/).filter(Boolean);
		const kept: string[] = [];
		for (let index = segments.length - 1; index >= 0; index -= 1) {
			const candidate = [segments[index], ...kept];
			const label = prefix + candidate.join(separator);
			if (label.length > maxLength && kept.length > 0) break;
			if (label.length > maxLength) {
				const remaining = Math.max(1, maxLength - prefix.length);
				return prefix + segments[segments.length - 1].slice(-remaining);
			}
			kept.unshift(segments[index]);
		}
		return prefix + kept.join(separator);
	}
</script>

<div class="flex min-w-0 shrink items-center gap-1">
	<button
		type="button"
		class="inline-flex h-8 min-w-0 max-w-48 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
		onclick={openTargetDialog}
		disabled={disabled || !activePath}
		aria-label={activePath || m.git_panel_select_project()}
		title={activePath || m.git_panel_select_project()}
	>
		<Folder class="h-4 w-4 shrink-0" />
		<span class="min-w-0 truncate">{displayPath || m.git_panel_select_project()}</span>
	</button>
	<GitBranchSelector
		currentBranch={target.branches.currentBranch || 'HEAD'}
		refs={target.branches.refs}
		isOpen={target.branches.showBranchDropdown}
		isLoading={target.branches.isLoadingBranches}
		{disabled}
		{isMobile}
		triggerClass="h-8 max-w-40 px-2 text-xs sm:max-w-80"
		labelClass="max-w-24 text-xs"
		onToggle={toggleBranchSelector}
		onClose={() => target.branches.closeBranchDropdown()}
		onCreateBranch={() => target.openNewBranchDialog()}
		onSwitchBranch={(branch, refKind) => void target.switchBranch(branch, refKind)}
		onSearchRefs={(query) => {
			if (target.activeProjectPath) {
				return target.branches.fetchRefs(target.activeProjectPath, query);
			}
		}}
	/>
</div>

{#if target.showTargetDialog && target.activeProjectPath}
	<GitTargetDialog
		initialPath={target.activeProjectPath}
		{projectBasePath}
		{pinnedProjectPaths}
		{isMobile}
		onConfirm={(candidate) => void target.selectTarget(candidate)}
		onTogglePinnedProjectPath={(path) =>
			void togglePinnedProjectPathOptimistically(remoteSettings, path)}
		onClose={() => (target.showTargetDialog = false)}
	/>
{/if}

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
