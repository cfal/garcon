<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import X from '@lucide/svelte/icons/x';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import type { PullRequestSummary } from '$lib/api/pull-requests';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';
	import { checksStateClass, checksStateLabel, prStateBadge } from './pr-display';
	import Markdown from '$lib/components/rich-text/Markdown.svelte';

	interface PullRequestHeaderProps {
		pull: PullRequestSummary;
		repositoryName: string;
		body: string;
		currentTime: Date;
		onRefresh: () => void;
		onClose?: () => void;
	}

	let { pull, repositoryName, body, currentTime, onRefresh, onClose }: PullRequestHeaderProps =
		$props();

	const stateBadge = $derived(prStateBadge(pull.state, pull.isDraft));
	const checksLabel = $derived(checksStateLabel(pull.checksState));
	const age = $derived(formatRelativeTimestamp(pull.createdAt || pull.updatedAt, currentTime));
</script>

<div class="border-b border-border px-4 pt-3 pb-3">
	<div class="flex items-center gap-2 text-xs text-muted-foreground">
		<span
			class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium {stateBadge.class}"
		>
			<GitPullRequest class="h-3.5 w-3.5" />
			{stateBadge.label}
		</span>
		<span class="min-w-0 truncate">{repositoryName} #{pull.number}</span>
		<span class="min-w-0 truncate font-mono">{pull.headRefName} → {pull.baseRefName}</span>
		<div class="ml-auto flex shrink-0 items-center gap-0.5">
			<button
				type="button"
				class="rounded-md p-1 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				onclick={onRefresh}
				aria-label={m.common_refresh()}
				title={m.common_refresh()}
			>
				<RefreshCw class="h-3.5 w-3.5" />
			</button>
			<a
				href={pull.url}
				target="_blank"
				rel="noreferrer noopener"
				class="rounded-md p-1 hover:bg-accent hover:text-foreground"
				aria-label={m.pull_request_open_on_github()}
				title={m.pull_request_open_on_github()}
			>
				<ExternalLink class="h-3.5 w-3.5" />
			</a>
			{#if onClose}
				<button
					type="button"
					class="rounded-md p-1 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					onclick={onClose}
					aria-label={m.pull_request_close()}
				>
					<X class="h-4 w-4" />
				</button>
			{/if}
		</div>
	</div>
	<h2 class="mt-2 text-lg leading-snug font-semibold text-foreground">{pull.title}</h2>
	<div class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
		<span class="font-medium text-foreground">{pull.author}</span>
		{#if age}<time datetime={pull.createdAt} title={age.tooltip}>{age.label}</time>{/if}
		{#if checksLabel}<span class={checksStateClass(pull.checksState)}>{checksLabel}</span>{/if}
	</div>
	{#if body.trim()}
		<details class="mt-2 text-xs">
			<summary class="cursor-pointer text-muted-foreground hover:text-foreground">
				{m.pull_request_description()}
			</summary>
			<div class="mt-1 max-h-64 overflow-y-auto">
				<Markdown source={body} class="markdown-body prose prose-sm max-w-none text-xs" />
			</div>
		</details>
	{/if}
</div>
