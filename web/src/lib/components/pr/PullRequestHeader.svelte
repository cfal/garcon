<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import X from '@lucide/svelte/icons/x';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { PullRequestSummary as PullRequestSummaryData } from '$lib/api/pull-requests';
	import Markdown from '$lib/components/rich-text/Markdown.svelte';
	import PullRequestStateBadge from './PullRequestStateBadge.svelte';
	import PullRequestSummary from './PullRequestSummary.svelte';

	// The header of a detail shown beside the inbox; narrow layouts use the nav bar instead.
	interface PullRequestHeaderProps {
		pull: PullRequestSummaryData;
		repositoryName: string;
		body: string;
		currentTime: Date;
		onRefresh: () => void;
		onShowChecks: () => void;
		onClose: () => void;
	}

	let {
		pull,
		repositoryName,
		body,
		currentTime,
		onRefresh,
		onShowChecks,
		onClose,
	}: PullRequestHeaderProps = $props();

	const iconButtonClass =
		'rounded-md p-1 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:p-2';
</script>

<div class="border-b border-border px-4 pt-3 pb-3">
	<div class="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
		<PullRequestStateBadge {pull} />
		<span class="min-w-0 truncate">{repositoryName} #{pull.number}</span>
		<div class="ml-auto flex shrink-0 items-center gap-0.5">
			<button
				type="button"
				class={iconButtonClass}
				onclick={onRefresh}
				aria-label={m.common_refresh()}
				title={m.common_refresh()}
			>
				<RefreshCw class="h-3.5 w-3.5 pointer-coarse:h-4 pointer-coarse:w-4" />
			</button>
			<button
				type="button"
				class={iconButtonClass}
				onclick={onClose}
				aria-label={m.pull_request_close()}
			>
				<X class="h-4 w-4" />
			</button>
		</div>
	</div>
	<PullRequestSummary {pull} {currentTime} {onShowChecks} />
	{#if body.trim()}
		<details class="mt-2 text-xs">
			<summary
				class="cursor-pointer text-muted-foreground hover:text-foreground pointer-coarse:py-1"
			>
				{m.pull_request_description()}
			</summary>
			<div class="mt-1 max-h-64 overflow-y-auto">
				<Markdown source={body} class="markdown-body prose prose-sm max-w-none text-xs" />
			</div>
		</details>
	{/if}
</div>
