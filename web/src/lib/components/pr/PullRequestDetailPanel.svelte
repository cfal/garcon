<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type {
		PullRequestDetailTab,
		PullRequestsStore,
	} from '$lib/git/pull-requests/pull-requests-store.svelte.js';
	import { cn } from '$lib/utils/cn';
	import PullRequestHeader from './PullRequestHeader.svelte';
	import PullRequestChangesTab from './PullRequestChangesTab.svelte';
	import PullRequestChecksTab from './PullRequestChecksTab.svelte';
	import PullRequestReviewTab from './PullRequestReviewTab.svelte';

	interface PullRequestDetailPanelProps {
		controller: PullRequestsStore;
		currentTime: Date;
		onOpenChat: (chatId: string) => void;
		// Absent in narrow layouts, where the back link closes the detail.
		onClose?: () => void;
	}

	let {
		controller: pullRequests,
		currentTime,
		onOpenChat,
		onClose,
	}: PullRequestDetailPanelProps = $props();
	const entry = $derived(pullRequests.selectedEntry);
	const detail = $derived(pullRequests.detail);
	const tabs: { id: PullRequestDetailTab; label: () => string }[] = [
		{ id: 'review', label: m.pull_request_tab_review },
		{ id: 'changes', label: m.pull_request_tab_changes },
		{ id: 'checks', label: m.pull_request_tab_checks },
	];

	// Arrow keys move between tabs, as the tab pattern expects.
	function handleTabKeydown(event: KeyboardEvent, index: number): void {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
		pullRequests.tab = next.id;
		(event.currentTarget as HTMLElement).parentElement
			?.querySelector<HTMLElement>(`[data-pr-tab="${next.id}"]`)
			?.focus();
	}
</script>

<div class="flex h-full flex-col bg-background">
	{#if entry}
		<PullRequestHeader
			pull={entry.pull}
			repositoryName={pullRequests.selectedRepository
				? pullRequests.reviews.repositoryLabel(pullRequests.selectedRepository.id)
				: ''}
			body={detail?.body ?? ''}
			{currentTime}
			onRefresh={() => void pullRequests.loadDetail()}
			{onClose}
		/>
		<div class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5" role="tablist">
			{#each tabs as tab, index (tab.id)}
				{@const selected = pullRequests.tab === tab.id}
				<button
					type="button"
					role="tab"
					aria-selected={selected}
					tabindex={selected ? 0 : -1}
					class={cn(
						'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
						selected
							? 'bg-muted font-medium text-foreground'
							: 'text-muted-foreground hover:text-foreground',
					)}
					data-pr-tab={tab.id}
					onclick={() => (pullRequests.tab = tab.id)}
					onkeydown={(event) => handleTabKeydown(event, index)}
				>
					{tab.label()}
					{#if tab.id === 'changes'}
						<span class="text-xs tabular-nums">
							<span class="text-git-added">+{entry.pull.additions.toLocaleString()}</span>
							<span class="text-git-deleted">−{entry.pull.deletions.toLocaleString()}</span>
						</span>
					{/if}
				</button>
			{/each}
		</div>
		<div class="flex min-h-0 flex-1 flex-col" role="tabpanel">
			{#if pullRequests.tab === 'review'}
				<PullRequestReviewTab controller={pullRequests} {currentTime} {onOpenChat} />
			{:else if detail}
				{#if pullRequests.tab === 'changes'}
					<PullRequestChangesTab {detail} />
				{:else}
					<PullRequestChecksTab checks={detail.checks} />
				{/if}
			{:else if pullRequests.isDetailLoading}
				<div class="flex h-full items-center justify-center text-muted-foreground">
					<LoaderCircle class="h-5 w-5 animate-spin" />
				</div>
			{:else if pullRequests.detailError}
				<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
					<TriangleAlert class="h-6 w-6 text-git-deleted" />
					<p class="text-sm text-muted-foreground">{pullRequests.detailError}</p>
					<button
						type="button"
						class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => void pullRequests.loadDetail()}
					>
						{m.common_retry()}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
