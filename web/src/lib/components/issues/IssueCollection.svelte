<script lang="ts">
	import type { IssueStatus, IssueSummary } from '$shared/issues';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import type { IssueWindowKey } from '$lib/issues/catalog/issue-collection.js';
	import { issueWindowLimit } from '$lib/issues/catalog/issue-collection.js';
	import IssueCard from './IssueCard.svelte';
	import { issueStatusLabel } from './issue-presentation.js';
	import { issueDropTarget } from './issue-drag.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		onOpen,
		onStatus,
		pinned = null,
	}: {
		controller: IssuesController;
		onOpen: (issue: IssueSummary) => void;
		onStatus: (issue: IssueSummary, status: IssueStatus) => void;
		pinned?: { key: IssueWindowKey; issue: IssueSummary } | null;
	} = $props();
	const collection = $derived(controller.displayedCollection);
	function items(key: IssueWindowKey) {
		const entries = collection?.windows[key]?.items ?? [];
		if (!pinned || pinned.key !== key) return entries;
		const pinnedIssue = pinned.issue;
		if (
			controller.mutations.busy(pinnedIssue.id) ||
			entries.some((issue) => issue.id === pinnedIssue.id)
		)
			return entries;
		return [pinnedIssue, ...entries.slice(0, issueWindowLimit(key) - 1)];
	}
</script>

{#snippet cards(key: IssueWindowKey)}
	{#each items(key) as issue (issue.id)}
		<svelte:boundary>
			<IssueCard
				{issue}
				board={controller.layout === 'board'}
				selected={controller.detail.selectedId === issue.id}
				showProject={!controller.collectionQuery.project}
				pending={controller.mutations.busy(issue.id)}
				{onOpen}
				{onStatus}
			/>
			{#snippet failed()}<p class="issue-notice">{m.issues_invalid_entry()}</p>{/snippet}
		</svelte:boundary>
	{/each}
	{@const page = controller.collection?.windows[key]}
	{#if page}<div class="issue-pagination">
			{#if page.pageIndex > 0}<button
					class="issue-button"
					disabled={!!controller.pagePending || controller.stale}
					onclick={() => void controller.page(key, 'previous')}>{m.issues_previous()}</button
				>{/if}
			{#if page.nextBeforeNumber !== null}<button
					class="issue-button"
					disabled={!!controller.pagePending || controller.stale}
					onclick={() =>
						void controller.page(key, page.items.length < issueWindowLimit(key) ? 'more' : 'next')}
					>{page.items.length < issueWindowLimit(key)
						? m.issues_load_more()
						: m.issues_next()}</button
				>{/if}
		</div>{/if}
{/snippet}
{#if controller.layout === 'list'}
	<div class="issue-list" data-issue-window="list" data-issue-scroll="list">
		{@render cards('list')}
		{#if controller.collection}<p class="issue-counts">
				{m.issues_counts({
					loaded: items('list').length,
					total: Object.values(collection!.counts.counts).reduce((sum, count) => sum + count, 0),
				})}
			</p>{/if}
	</div>
{:else}
	<nav class="issue-lane-tabs" aria-label={m.issues_status()}>
		{#each controller.lanes as status (status)}<button
				class="issue-button"
				aria-pressed={controller.activeLane === status}
				onclick={() => (controller.activeLane = status)}
				>{issueStatusLabel(status)} · {collection?.counts.counts[status] ?? 0}</button
			>{/each}
	</nav>
	<div class="issue-board">
		{#each controller.lanes as status (status)}
			<section
				class="issue-lane"
				data-status={status}
				data-active={controller.activeLane === status}
				data-issue-window={status}
				use:issueDropTarget={{ status, onDrop: onStatus }}
				aria-label={issueStatusLabel(status)}
			>
				<h3 tabindex="-1" data-issue-focus={JSON.stringify({ kind: 'lane', status })}>
					<span class="issue-status-dot" aria-hidden="true"></span>{issueStatusLabel(status)}<span
						class="issue-counts"
						>{m.issues_counts({
							loaded: items(status).length,
							total: collection?.counts.counts[status] ?? 0,
						})}</span
					>
				</h3>
				<div class="issue-lane-scroll" data-issue-scroll={status}>{@render cards(status)}</div>
			</section>
		{/each}
	</div>
{/if}
