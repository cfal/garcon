<script lang="ts">
	// Unified top toolbar for the Git panel. Renders mode-specific
	// action sets for Changes and History views. Owns branch selector,
	// mode toggle, and all primary git actions.

	import GitBranch from '@lucide/svelte/icons/git-branch';
	import Plus from '@lucide/svelte/icons/plus';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Search from '@lucide/svelte/icons/search';
	import History from '@lucide/svelte/icons/history';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Upload from '@lucide/svelte/icons/upload';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Folder from '@lucide/svelte/icons/folder';
	import GitDiffSettingsMenu from './GitDiffSettingsMenu.svelte';
	import type { GitRemoteStatus, GitTargetCandidate } from '$lib/api/git';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitTopToolbarProps {
		isMobile: boolean;
		activeView: 'changes' | 'history';
		currentBranch: string;
		branches: string[];
		remoteStatus: GitRemoteStatus | null;
		targets?: GitTargetCandidate[];
		activeWorktreePath?: string | null;
		isLoadingTargets?: boolean;
		showBranchDropdown: boolean;
		isLoading: boolean;
		isPushing: boolean;
		reviewCount: number;
		canCommit: boolean;
		isCommitting: boolean;
		canPush: boolean;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: string;
		onToggleBranchDropdown: () => void;
		onCloseBranchDropdown: () => void;
		onShowNewBranchModal: () => void;
		onSwitchBranch: (branch: string) => void;
		onOpenWorktrees?: () => void;
		onViewCommits: () => void;
		onViewChanges: () => void;
		onOpenReview: () => void;
		onCommit: () => void;
		onPush: () => void;
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => void;
		onSetDiffFontSize: (size: string) => void;
		onOpenCommitSettings: () => void;
		onRevert: () => void;
		onRefresh: () => void;
	}

	let {
		isMobile,
		activeView,
		currentBranch,
		branches,
		remoteStatus,
		targets = [],
		activeWorktreePath = null,
		isLoadingTargets = false,
		showBranchDropdown,
		isLoading,
		isPushing,
		reviewCount,
		canCommit,
		isCommitting,
		canPush,
		diffMode,
		contextLines,
		diffFontSize,
		onToggleBranchDropdown,
		onCloseBranchDropdown,
		onShowNewBranchModal,
		onSwitchBranch,
		onOpenWorktrees,
		onViewCommits,
		onViewChanges,
		onOpenReview,
		onCommit,
		onPush,
		onSetDiffMode,
		onSetContextLines,
		onSetDiffFontSize,
		onOpenCommitSettings,
		onRevert,
		onRefresh,
	}: GitTopToolbarProps = $props();

	let dropdownEl: HTMLDivElement;
	let branchSearchInput = $state<HTMLInputElement | null>(null);
	let branchSearchQuery = $state('');

	let currentBranchLabel = $derived(currentBranch || remoteStatus?.branch || 'Branch');
	let activeWorktreeFullPath = $derived(
		activeWorktreePath ??
			targets.find((target) => target.isCurrent && !target.isMissing)?.worktreePath ??
			'',
	);
	let activeWorktreeDisplayPath = $derived(
		formatFrontEllipsisPath(activeWorktreeFullPath, isMobile ? 24 : 34),
	);
	let filteredBranches = $derived.by(() => {
		const query = branchSearchQuery.trim().toLowerCase();
		if (!query) return branches;
		return branches.filter((branch) => branch.toLowerCase().includes(query));
	});

	function handleClickOutside(event: MouseEvent) {
		if (dropdownEl && !dropdownEl.contains(event.target as Node)) {
			onCloseBranchDropdown();
		}
	}

	$effect(() => {
		if (showBranchDropdown) {
			document.addEventListener('mousedown', handleClickOutside);
			queueMicrotask(() => branchSearchInput?.focus());
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
		branchSearchQuery = '';
	});

	function handleBranchMenuKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		onCloseBranchDropdown();
	}

	function formatFrontEllipsisPath(path: string, maxLength: number): string {
		const normalized = path.trim();
		if (!normalized || normalized.length <= maxLength) return normalized;

		const separator = normalized.includes('\\') && !normalized.includes('/') ? '\\' : '/';
		const prefix = normalized.startsWith(separator) ? `${separator}...${separator}` : `...${separator}`;
		const segments = normalized.split(/[\\/]+/).filter(Boolean);
		if (segments.length === 0) return normalized.slice(-maxLength);

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

<div
	class="flex items-center justify-between border-b border-border {isMobile
		? 'px-2 py-1'
		: 'px-3 py-1'}"
>
	<!-- Left: branch selector + mode badge -->
	<div class="flex items-center gap-2">
		{#if activeWorktreeFullPath}
			<button
				type="button"
				onclick={() => onOpenWorktrees?.()}
				disabled={isLoadingTargets}
				aria-haspopup="dialog"
				aria-label={`Open Git target selector, current folder ${activeWorktreeFullPath}`}
				class="flex items-center hover:bg-accent rounded-lg transition-colors duration-150 disabled:opacity-50 {isMobile
					? 'gap-1.5 px-2 py-1'
					: 'gap-1.5 px-3 py-1.5'}"
				title={activeWorktreeFullPath}
			>
				<Folder class="text-muted-foreground w-4 h-4" />
				<span class="text-sm font-medium max-w-[180px] truncate">{activeWorktreeDisplayPath}</span>
				<ChevronDown class="w-3.5 h-3.5 text-muted-foreground" />
			</button>
		{/if}

		<!-- Branch selector -->
		<div class="relative" bind:this={dropdownEl}>
			<button
				type="button"
				onclick={onToggleBranchDropdown}
				aria-haspopup="listbox"
				aria-expanded={showBranchDropdown}
				aria-label={`Switch branch, current branch ${currentBranchLabel}`}
				class="flex items-center hover:bg-accent rounded-lg transition-colors duration-150 {isMobile
					? 'gap-1.5 px-2 py-1'
					: 'gap-1.5 px-3 py-1.5'}"
			>
				<GitBranch class="text-muted-foreground w-4 h-4" />
				<span class="text-sm font-medium max-w-[140px] truncate">{currentBranchLabel}</span>
				{#if remoteStatus?.hasRemote}
					<div class="flex items-center gap-0.5 text-xs">
						{#if remoteStatus.ahead > 0}
							<span class="text-status-success-foreground">{'\u2191'}{remoteStatus.ahead}</span>
						{/if}
						{#if remoteStatus.behind > 0}
							<span class="text-interactive-accent">{'\u2193'}{remoteStatus.behind}</span>
						{/if}
						{#if remoteStatus.isUpToDate}
							<span class="text-muted-foreground">{'\u2713'}</span>
						{/if}
					</div>
				{/if}
				<ChevronDown
					class="w-3.5 h-3.5 text-muted-foreground transition-transform {showBranchDropdown
						? 'rotate-180'
						: ''}"
				/>
			</button>

			{#if showBranchDropdown}
				<div
					class="absolute top-full left-0 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-lg z-50"
					onkeydown={handleBranchMenuKeydown}
					role="dialog"
					aria-label="Switch branches"
					tabindex="-1"
				>
					<div class="border-b border-border px-3 py-2">
						<div class="mb-2 text-xs font-medium text-foreground">Switch branches</div>
						<div class="relative">
							<Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
							<input
								bind:this={branchSearchInput}
								type="text"
								value={branchSearchQuery}
								oninput={(event) => {
									branchSearchQuery = event.currentTarget.value;
								}}
								placeholder="Find a branch..."
								class="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								aria-label="Find a branch"
								role="combobox"
								aria-controls="git-branch-listbox"
								aria-expanded="true"
								aria-autocomplete="list"
							/>
						</div>
					</div>
					<div class="border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
						Branches
					</div>
					<div
						id="git-branch-listbox"
						class="max-h-64 overflow-y-auto py-1"
						role="listbox"
						aria-label="Branches"
					>
						{#if filteredBranches.length === 0}
							<div class="px-3 py-3 text-center text-xs text-muted-foreground">
								No branches found.
							</div>
						{/if}
						{#each filteredBranches as branch (branch)}
							<button
								type="button"
								onclick={() => onSwitchBranch(branch)}
								role="option"
								aria-selected={branch === currentBranchLabel}
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent {branch ===
								currentBranchLabel
									? 'bg-accent/50 font-medium'
									: 'text-muted-foreground'}"
							>
								<span class="flex h-4 w-4 shrink-0 items-center justify-center">
									{#if branch === currentBranchLabel}
										<Check class="h-3.5 w-3.5 text-status-success-foreground" />
									{/if}
								</span>
								<span class="min-w-0 truncate">{branch}</span>
							</button>
						{/each}
					</div>
					<div class="border-t border-border py-1">
						<button
							type="button"
							onclick={() => {
								onShowNewBranchModal();
								onCloseBranchDropdown();
							}}
							class="w-full text-left px-4 py-2 text-sm hover:bg-accent flex items-center space-x-2"
						>
							<Plus class="w-3.5 h-3.5" />
							<span>{m.git_header_create_branch()}</span>
						</button>
					</div>
				</div>
			{/if}
		</div>

	</div>

	<!-- Right: mode-specific actions -->
	<div class="flex items-center {isMobile ? 'gap-1' : 'gap-1.5'}">
		{#if activeView === 'changes'}
			<!-- View commits toggle -->
			<button
				onclick={onViewCommits}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-150"
				title={m.git_view_commit_history()}
			>
				<History class="w-4 h-4" />
				{#if !isMobile}History{/if}
			</button>

			<!-- Review -->
			<button
				onclick={onOpenReview}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-all duration-200
					{reviewCount > 0
					? 'bg-interactive-accent/10 text-interactive-accent border-interactive-accent/30 hover:bg-interactive-accent/20'
					: 'border-border bg-background text-muted-foreground hover:text-foreground'}"
				title={m.git_review_changes()}
			>
				<MessageSquare class="w-4 h-4" />
				{#if !isMobile}Review{/if}
				{#if reviewCount > 0}
					<span
						class="px-1.5 py-0 text-[10px] rounded-full bg-interactive-accent text-interactive-accent-foreground font-medium"
					>
						{reviewCount}
					</span>
				{/if}
			</button>

			<!-- Commit -->
			<button
				onclick={onCommit}
				disabled={!canCommit || isCommitting}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-200
					{canCommit && !isCommitting
					? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
					: 'bg-muted text-muted-foreground cursor-not-allowed'}"
				title={m.git_changes_commit_staged()}
			>
				Commit
			</button>

			<!-- Push -->
			<button
				onclick={onPush}
				disabled={!canPush || isPushing}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-200
					{canPush && !isPushing
					? 'bg-git-action-push text-git-action-foreground hover:bg-git-action-push-hover'
					: 'bg-muted text-muted-foreground cursor-not-allowed'}"
				title={m.git_header_push_to_remote()}
				aria-label={m.git_header_push()}
			>
				<Upload class="w-4 h-4 {isPushing ? 'animate-pulse' : ''}" />
				{#if !isMobile}Push{/if}
			</button>

			<!-- Settings popup -->
			<GitDiffSettingsMenu
				{diffMode}
				{contextLines}
				{diffFontSize}
				{onSetDiffMode}
				{onSetContextLines}
				{onSetDiffFontSize}
				{onOpenCommitSettings}
			/>

			<!-- Refresh -->
			<button
				onclick={onRefresh}
				disabled={isLoading}
				class="p-2 rounded-lg hover:bg-muted transition-all duration-200 text-muted-foreground"
				title={m.git_header_refresh()}
			>
				<RefreshCw class="w-4 h-4 {isLoading ? 'animate-spin' : ''}" />
			</button>
		{:else}
			<!-- History mode actions -->

			<!-- Back to changes -->
			<button
				onclick={onViewChanges}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-150"
				title={m.git_view_changes()}
			>
				<ArrowLeft class="w-4 h-4" />
				{#if !isMobile}Changes{/if}
			</button>

			<!-- Revert -->
			<button
				onclick={onRevert}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-status-warning hover:bg-status-warning/10 transition-all duration-200"
				title={m.git_revert_last_commit()}
			>
				<Undo2 class="w-4 h-4" />
				{#if !isMobile}Revert{/if}
			</button>

			<!-- Refresh -->
			<button
				onclick={onRefresh}
				disabled={isLoading}
				class="p-2 rounded-lg hover:bg-muted transition-all duration-200 text-muted-foreground"
				title={m.git_header_refresh()}
			>
				<RefreshCw class="w-4 h-4 {isLoading ? 'animate-spin' : ''}" />
			</button>
		{/if}
	</div>
</div>
