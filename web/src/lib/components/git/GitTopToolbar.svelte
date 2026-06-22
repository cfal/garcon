<script lang="ts">
	// Unified top toolbar for the Git panel. Renders mode-specific
	// action sets for Changes and History views. Owns branch selector,
	// mode toggle, and all primary git actions.

	import GitBranch from '@lucide/svelte/icons/git-branch';
	import Plus from '@lucide/svelte/icons/plus';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Search from '@lucide/svelte/icons/search';
	import History from '@lucide/svelte/icons/history';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Upload from '@lucide/svelte/icons/upload';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Folder from '@lucide/svelte/icons/folder';
	import GitDiffSettingsMenu from './GitDiffSettingsMenu.svelte';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import type { GitRemoteStatus, GitTargetCandidate } from '$lib/api/git';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	type ToolbarActionId = 'history' | 'review' | 'commit' | 'push' | 'refresh' | 'changes' | 'revert';

	interface ToolbarAction {
		id: ToolbarActionId;
		label: string;
		title: string;
		disabled: boolean;
		priority: number;
		showMobileLabel?: boolean;
		onclick: () => void;
	}

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
	let actionRailEl = $state<HTMLDivElement | null>(null);
	let measurementRailEl = $state<HTMLDivElement | null>(null);
	let branchSearchInput = $state<HTMLInputElement | null>(null);
	let branchSearchQuery = $state('');
	let actionRailWidth = $state(0);
	let actionWidths = $state<Record<ToolbarActionId, number>>({
		history: 0,
		review: 0,
		commit: 0,
		push: 0,
		refresh: 0,
		changes: 0,
		revert: 0,
	});
	let moreButtonWidth = $state(0);
	let settingsButtonWidth = $state(0);

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
	let toolbarGapPx = $derived(isMobile ? 4 : 6);
	let showSettingsAction = $derived(activeView === 'changes');
	let toolbarActions = $derived.by<ToolbarAction[]>(() => {
		if (activeView === 'history') {
			return [
				{
					id: 'changes',
					label: 'Changes',
					title: m.git_view_changes(),
					disabled: false,
					priority: 0,
					onclick: onViewChanges,
				},
				{
					id: 'revert',
					label: 'Revert',
					title: m.git_revert_last_commit(),
					disabled: false,
					priority: 2,
					onclick: onRevert,
				},
				{
					id: 'refresh',
					label: m.git_header_refresh(),
					title: m.git_header_refresh(),
					disabled: isLoading,
					priority: 1,
					onclick: onRefresh,
				},
			];
		}

		return [
			{
				id: 'history',
				label: 'History',
				title: m.git_view_commit_history(),
				disabled: false,
				priority: 4,
				onclick: onViewCommits,
			},
			{
				id: 'review',
				label: 'Review',
				title: m.git_review_changes(),
				disabled: false,
				priority: 2,
				onclick: onOpenReview,
			},
			{
				id: 'commit',
				label: 'Commit',
				title: m.git_changes_commit_staged(),
				disabled: !canCommit || isCommitting,
				priority: 0,
				showMobileLabel: true,
				onclick: onCommit,
			},
			{
				id: 'push',
				label: 'Push',
				title: m.git_header_push_to_remote(),
				disabled: !canPush || isPushing,
				priority: 3,
				onclick: onPush,
			},
			{
				id: 'refresh',
				label: m.git_header_refresh(),
				title: m.git_header_refresh(),
				disabled: isLoading,
				priority: 1,
				onclick: onRefresh,
			},
		];
	});
	let visibleActionIds = $derived.by(() =>
		computeVisibleActionIds(
			toolbarActions,
			availableCommandWidth(),
			actionWidths,
			moreButtonWidth,
			toolbarGapPx,
		),
	);
	let visibleActions = $derived(toolbarActions.filter((action) => visibleActionIds.has(action.id)));
	let overflowActions = $derived(toolbarActions.filter((action) => !visibleActionIds.has(action.id)));
	let visibleActionsBeforeSettings = $derived(
		visibleActions.filter((action) => !isActionAfterSettings(action)),
	);
	let visibleActionsAfterSettings = $derived(
		visibleActions.filter((action) => isActionAfterSettings(action)),
	);

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

	function isActionAfterSettings(action: ToolbarAction): boolean {
		return activeView === 'changes' && action.id === 'refresh';
	}

	function actionButtonClass(action: ToolbarAction): string {
		if (action.id === 'review') {
			return `flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-all duration-200 ${
				reviewCount > 0
					? 'bg-interactive-accent/10 text-interactive-accent border-interactive-accent/30 hover:bg-interactive-accent/20'
					: 'border-border bg-background text-muted-foreground hover:text-foreground'
			}`;
		}

		if (action.id === 'commit') {
			return `flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-200 ${
				canCommit && !isCommitting
					? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
					: 'bg-muted text-muted-foreground cursor-not-allowed'
			}`;
		}

		if (action.id === 'push') {
			return `flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-200 ${
				canPush && !isPushing
					? 'bg-git-action-push text-git-action-foreground hover:bg-git-action-push-hover'
					: 'bg-muted text-muted-foreground cursor-not-allowed'
			}`;
		}

		if (action.id === 'revert') {
			return 'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-status-warning hover:bg-status-warning/10 transition-all duration-200';
		}

		if (action.id === 'refresh') {
			return 'p-2 rounded-lg hover:bg-muted transition-all duration-200 text-muted-foreground disabled:opacity-50';
		}

		return 'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-150';
	}

	function availableCommandWidth(): number {
		if (!showSettingsAction) return actionRailWidth;
		const settingsReserve = settingsButtonWidth > 0 ? settingsButtonWidth + toolbarGapPx : 0;
		return Math.max(0, actionRailWidth - settingsReserve);
	}

	function computeVisibleActionIds(
		actions: ToolbarAction[],
		availableWidth: number,
		widths: Record<ToolbarActionId, number>,
		moreWidth: number,
		gapPx: number,
	): Set<ToolbarActionId> {
		const allIds = new Set(actions.map((action) => action.id));
		if (availableWidth <= 0 || moreWidth <= 0 || actions.some((action) => !widths[action.id])) {
			return allIds;
		}

		if (toolbarActionsWidth(actions, widths, gapPx, false) <= availableWidth) return allIds;

		const visibleIds = new Set<ToolbarActionId>();
		const priorityOrder = [...actions].sort((left, right) => {
			if (left.priority !== right.priority) return left.priority - right.priority;
			return actions.indexOf(left) - actions.indexOf(right);
		});

		for (const action of priorityOrder) {
			const nextVisibleIds = new Set(visibleIds);
			nextVisibleIds.add(action.id);
			const visible = actions.filter((candidate) => nextVisibleIds.has(candidate.id));
			if (toolbarActionsWidth(visible, widths, gapPx, true, moreWidth) <= availableWidth) {
				visibleIds.add(action.id);
			}
		}

		return visibleIds;
	}

	function toolbarActionsWidth(
		actions: ToolbarAction[],
		widths: Record<ToolbarActionId, number>,
		gapPx: number,
		includeMore: boolean,
		moreWidth = 0,
	): number {
		const actionWidth = actions.reduce((total, action) => total + widths[action.id], 0);
		const itemCount = actions.length + (includeMore ? 1 : 0);
		const gapWidth = Math.max(0, itemCount - 1) * gapPx;
		return actionWidth + (includeMore ? moreWidth : 0) + gapWidth;
	}

	function measureActions(): void {
		const rail = measurementRailEl;
		if (!rail) return;

		const nextWidths: Record<ToolbarActionId, number> = {
			history: 0,
			review: 0,
			commit: 0,
			push: 0,
			refresh: 0,
			changes: 0,
			revert: 0,
		};
		for (const action of toolbarActions) {
			const element = rail.querySelector<HTMLElement>(
				`[data-git-toolbar-measure-action="${action.id}"]`,
			);
			nextWidths[action.id] = element?.offsetWidth ?? 0;
		}

		actionWidths = nextWidths;
		moreButtonWidth =
			rail.querySelector<HTMLElement>('[data-git-toolbar-measure-more]')?.offsetWidth ?? 0;
		settingsButtonWidth =
			rail.querySelector<HTMLElement>('[data-git-toolbar-measure-settings]')?.offsetWidth ?? 0;
	}

	$effect(() => {
		const rail = actionRailEl;
		if (!rail) return;

		function updateWidth(width: number): void {
			actionRailWidth = Math.max(0, Math.round(width));
		}

		updateWidth(rail.clientWidth);
		if (typeof ResizeObserver === 'undefined') return;

		const resizeObserver = new ResizeObserver((entries) => {
			updateWidth(entries[0]?.contentRect.width ?? rail.clientWidth);
		});
		resizeObserver.observe(rail);
		return () => resizeObserver.disconnect();
	});

	$effect(() => {
		const rail = measurementRailEl;
		const actions = toolbarActions;
		const mobile = isMobile;
		const settingsVisible = showSettingsAction;
		void actions;
		void mobile;
		void settingsVisible;

		queueMicrotask(measureActions);
		if (!rail || typeof ResizeObserver === 'undefined') return;

		const resizeObserver = new ResizeObserver(() => measureActions());
		resizeObserver.observe(rail);
		return () => resizeObserver.disconnect();
	});

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

{#snippet actionIcon(actionId: ToolbarActionId)}
	{#if actionId === 'history'}
		<History class="w-4 h-4" />
	{:else if actionId === 'review'}
		<MessageSquare class="w-4 h-4" />
	{:else if actionId === 'push'}
		<Upload class="w-4 h-4 {isPushing ? 'animate-pulse' : ''}" />
	{:else if actionId === 'refresh'}
		<RefreshCw class="w-4 h-4 {isLoading ? 'animate-spin' : ''}" />
	{:else if actionId === 'changes'}
		<ArrowLeft class="w-4 h-4" />
	{:else if actionId === 'revert'}
		<Undo2 class="w-4 h-4" />
	{/if}
{/snippet}

{#snippet actionBadge(action: ToolbarAction)}
	{#if action.id === 'review' && reviewCount > 0}
		<span
			class="px-1.5 py-0 text-[10px] rounded-full bg-interactive-accent text-interactive-accent-foreground font-medium"
		>
			{reviewCount}
		</span>
	{/if}
{/snippet}

{#snippet actionButton(action: ToolbarAction, measurement = false)}
	<button
		type="button"
		onclick={measurement ? undefined : action.onclick}
		disabled={action.disabled}
		tabindex={measurement ? -1 : undefined}
		class={actionButtonClass(action)}
		title={action.title}
		aria-label={action.id === 'push' ? m.git_header_push() : action.title}
		data-git-toolbar-measure-action={measurement ? action.id : undefined}
	>
		{@render actionIcon(action.id)}
		{#if action.showMobileLabel || (!isMobile && action.id !== 'refresh')}
			<span>{action.label}</span>
		{/if}
		{@render actionBadge(action)}
	</button>
{/snippet}

<div
	class="flex items-center justify-between border-b border-border {isMobile
		? 'px-2 py-1'
		: 'px-3 py-1'}"
>
	<!-- Left: branch selector + mode badge -->
	<div class="flex min-w-0 items-center gap-2">
		{#if activeWorktreeFullPath}
			<button
				type="button"
				onclick={() => onOpenWorktrees?.()}
				disabled={isLoadingTargets}
				aria-haspopup="dialog"
				aria-label={`Open Git target selector, current folder ${activeWorktreeFullPath}`}
				class="min-w-0 flex items-center hover:bg-accent rounded-lg transition-colors duration-150 disabled:opacity-50 {isMobile
					? 'gap-1.5 px-2 py-1'
					: 'gap-1.5 px-3 py-1.5'}"
				title={activeWorktreeFullPath}
			>
				<Folder class="text-muted-foreground w-4 h-4" />
				<span
					class="text-sm font-medium truncate {isMobile ? 'max-w-[7rem]' : 'max-w-[180px]'}"
					>{activeWorktreeDisplayPath}</span
				>
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
				class="min-w-0 flex items-center hover:bg-accent rounded-lg transition-colors duration-150 {isMobile
					? 'gap-1.5 px-2 py-1'
					: 'gap-1.5 px-3 py-1.5'}"
			>
				<GitBranch class="text-muted-foreground w-4 h-4" />
				<span
					class="text-sm font-medium truncate {isMobile ? 'max-w-[6rem]' : 'max-w-[140px]'}"
					>{currentBranchLabel}</span
				>
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
	<div
		bind:this={actionRailEl}
		data-git-toolbar-action-rail
		class="relative flex min-w-[2.5rem] flex-1 items-center justify-end {isMobile
			? 'gap-1'
			: 'gap-1.5'}"
	>
		{#each visibleActionsBeforeSettings as action (action.id)}
			{@render actionButton(action)}
		{/each}

		{#if showSettingsAction}
			<GitDiffSettingsMenu
				{diffMode}
				{contextLines}
				{diffFontSize}
				{onSetDiffMode}
				{onSetContextLines}
				{onSetDiffFontSize}
				{onOpenCommitSettings}
			/>
		{/if}

		{#each visibleActionsAfterSettings as action (action.id)}
			{@render actionButton(action)}
		{/each}

		{#if overflowActions.length > 0}
			<DropdownMenu>
				<DropdownMenuTrigger>
					<button
						type="button"
						class="p-2 rounded-lg hover:bg-muted transition-all duration-200 text-muted-foreground"
						title="More Git actions"
						aria-label="More Git actions"
					>
						<Ellipsis class="w-4 h-4" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{#each overflowActions as action (action.id)}
						<DropdownMenuItem disabled={action.disabled} onclick={action.onclick}>
							{@render actionIcon(action.id)}
							<span>{action.label}</span>
							{#if action.id === 'review' && reviewCount > 0}
								<span class="ml-auto text-xs text-muted-foreground">{reviewCount}</span>
							{/if}
						</DropdownMenuItem>
					{/each}
				</DropdownMenuContent>
			</DropdownMenu>
		{/if}
	</div>

	<div
		bind:this={measurementRailEl}
		class="pointer-events-none invisible absolute -left-[10000px] top-0 flex items-center {isMobile
			? 'gap-1'
			: 'gap-1.5'}"
		aria-hidden="true"
	>
		{#each toolbarActions as action (action.id)}
			{@render actionButton(action, true)}
		{/each}
		{#if showSettingsAction}
			<button
				type="button"
				tabindex="-1"
				class="inline-flex size-8 items-center justify-center rounded-md text-sm font-medium"
				data-git-toolbar-measure-settings
			>
				<RefreshCw class="w-4 h-4" />
			</button>
		{/if}
		<button
			type="button"
			tabindex="-1"
			class="p-2 rounded-lg text-muted-foreground"
			data-git-toolbar-measure-more
		>
			<Ellipsis class="w-4 h-4" />
		</button>
	</div>
</div>
