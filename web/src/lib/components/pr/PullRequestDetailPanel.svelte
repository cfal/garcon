<script lang="ts">
	import { tick } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type {
		PullRequestDetailTab,
		PullRequestsStore,
	} from '$lib/git/pull-requests/pull-requests-store.svelte.js';
	import { cn } from '$lib/utils/cn';
	import type { ContainerPresentation } from '$lib/components/shared/container-presentation.js';
	import PullRequestHeader from './PullRequestHeader.svelte';
	import PullRequestNavBar from './PullRequestNavBar.svelte';
	import PullRequestStateBadge from './PullRequestStateBadge.svelte';
	import PullRequestSummary from './PullRequestSummary.svelte';
	import PullRequestDescription from './PullRequestDescription.svelte';
	import PullRequestChangesTab from './PullRequestChangesTab.svelte';
	import PullRequestChecksTab from './PullRequestChecksTab.svelte';
	import PullRequestReviewTab from './PullRequestReviewTab.svelte';

	interface PullRequestDetailPanelProps {
		controller: PullRequestsStore;
		presentation: ContainerPresentation;
		currentTime: Date;
		onOpenChat: (chatId: string) => void;
		// Returns to the inbox: a back step when the detail replaces the list, otherwise a close.
		onDismiss: () => void;
	}

	let {
		controller: pullRequests,
		presentation,
		currentTime,
		onOpenChat,
		onDismiss,
	}: PullRequestDetailPanelProps = $props();
	const entry = $derived(pullRequests.selectedEntry);
	const detail = $derived(pullRequests.detail);
	const narrow = $derived(presentation === 'narrow');
	const repositoryName = $derived(
		pullRequests.selectedRepository
			? pullRequests.reviews.repositoryLabel(pullRequests.selectedRepository.id)
			: '',
	);
	const tabs: { id: PullRequestDetailTab; label: () => string }[] = [
		{ id: 'review', label: m.pull_request_tab_review },
		{ id: 'changes', label: m.pull_request_tab_changes },
		{ id: 'checks', label: m.pull_request_tab_checks },
	];
	let scrollBody = $state<HTMLElement | null>(null);
	let identityHeight = $state(0);
	let pinnedTabListHeight = $state(0);

	// A narrow body scrolls its identity block away; switching tabs keeps it scrolled away rather
	// than jumping back to the top, as long as the new tab is tall enough to stay there.
	async function selectTab(id: PullRequestDetailTab): Promise<void> {
		const previousScroll = scrollBody?.scrollTop ?? 0;
		pullRequests.tab = id;
		await tick();
		if (scrollBody) scrollBody.scrollTop = Math.min(previousScroll, identityHeight);
	}

	// Arrow keys move between tabs, as the tab pattern expects.
	function handleTabKeydown(event: KeyboardEvent, index: number): void {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
		const list = (event.currentTarget as HTMLElement).parentElement;
		void selectTab(next.id).then(() =>
			list
				?.querySelector<HTMLElement>(`[data-pr-tab="${next.id}"]`)
				?.focus({ preventScroll: true }),
		);
	}
</script>

{#snippet tabList()}
	<!-- Narrow layouts split the row into equal segments so each tab is a full-size touch target. -->
	<div
		class={cn(
			'shrink-0 items-center gap-1 border-b border-border bg-background px-3 py-1.5',
			narrow ? 'grid grid-cols-3' : 'flex',
		)}
		role="tablist"
	>
		{#each tabs as tab, index (tab.id)}
			{@const selected = pullRequests.tab === tab.id}
			<button
				type="button"
				role="tab"
				aria-selected={selected}
				tabindex={selected ? 0 : -1}
				class={cn(
					'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
					narrow && 'min-w-0 justify-center px-2 pointer-coarse:py-2',
					selected
						? 'bg-muted font-medium text-foreground'
						: 'text-muted-foreground hover:text-foreground',
				)}
				data-pr-tab={tab.id}
				onclick={() => void selectTab(tab.id)}
				onkeydown={(event) => handleTabKeydown(event, index)}
			>
				{tab.label()}
				{#if tab.id === 'changes' && !narrow && entry}
					<span class="text-xs tabular-nums">
						<span class="text-git-added">+{entry.pull.additions.toLocaleString()}</span>
						<span class="text-git-deleted">−{entry.pull.deletions.toLocaleString()}</span>
					</span>
				{/if}
			</button>
		{/each}
	</div>
{/snippet}

{#snippet tabPanel(fillsScrollBody: boolean)}
	<!-- Filling the scroll body below the pinned tabs lets the identity always scroll fully away,
	     so short tabs neither strand it half visible nor jump when tabs change. -->
	<div
		class="flex min-h-0 flex-1 flex-col"
		style:min-height={fillsScrollBody ? `calc(100% - ${pinnedTabListHeight}px)` : undefined}
		role="tabpanel"
		data-pr-tab-panel={pullRequests.tab}
	>
		{#if pullRequests.tab === 'review'}
			<PullRequestReviewTab controller={pullRequests} {currentTime} {onOpenChat} />
		{:else if detail}
			{#if pullRequests.tab === 'changes'}
				<PullRequestChangesTab {detail} {presentation} />
			{:else}
				<PullRequestChecksTab checks={detail.checks} />
			{/if}
		{:else if pullRequests.isDetailLoading}
			<div class="flex h-full min-h-48 items-center justify-center text-muted-foreground">
				<LoaderCircle class="h-5 w-5 animate-spin" />
			</div>
		{:else if pullRequests.detailError}
			<div class="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
				<TriangleAlert class="h-6 w-6 text-git-deleted" />
				<p class="text-sm text-muted-foreground">{pullRequests.detailError}</p>
				<button
					type="button"
					class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:py-2"
					onclick={() => void pullRequests.loadDetail()}
				>
					{m.common_retry()}
				</button>
			</div>
		{/if}
	</div>
{/snippet}

<div class="flex h-full flex-col bg-background">
	{#if entry && narrow}
		<PullRequestNavBar
			pull={entry.pull}
			{repositoryName}
			onBack={onDismiss}
			onRefresh={() => void pullRequests.loadDetail()}
		/>
		{#if pullRequests.tab === 'changes'}
			<!-- The diff scrolls itself, so Changes gives it the full height below the tabs. -->
			{@render tabList()}
			{@render tabPanel(false)}
		{:else}
			<div class="min-h-0 flex-1 overflow-y-auto" bind:this={scrollBody} data-pr-detail-scroll>
				<div class="px-4 pt-3 pb-3" bind:offsetHeight={identityHeight} data-pr-identity>
					<div
						class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
					>
						<PullRequestStateBadge pull={entry.pull} />
						<span class="tabular-nums">
							<span class="text-git-added">+{entry.pull.additions.toLocaleString()}</span>
							<span class="text-git-deleted">−{entry.pull.deletions.toLocaleString()}</span>
						</span>
						<span aria-hidden="true">·</span>
						<span>{m.pull_request_changed_files({ count: entry.pull.changedFiles })}</span>
					</div>
					<PullRequestSummary
						pull={entry.pull}
						{currentTime}
						onShowChecks={() => void selectTab('checks')}
					/>
					<PullRequestDescription body={detail?.body ?? ''} />
				</div>
				<div class="sticky top-0 z-10" bind:offsetHeight={pinnedTabListHeight}>
					{@render tabList()}
				</div>
				{@render tabPanel(true)}
			</div>
		{/if}
	{:else if entry}
		<PullRequestHeader
			pull={entry.pull}
			{repositoryName}
			body={detail?.body ?? ''}
			{currentTime}
			onRefresh={() => void pullRequests.loadDetail()}
			onShowChecks={() => void selectTab('checks')}
			onClose={onDismiss}
		/>
		{@render tabList()}
		{@render tabPanel(false)}
	{/if}
</div>
