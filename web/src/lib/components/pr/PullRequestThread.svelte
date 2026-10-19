<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import History from '@lucide/svelte/icons/history';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Markdown from '$lib/components/rich-text/Markdown.svelte';
	import type { PullRequestThread } from '$lib/api/pull-requests';

	interface PullRequestThreadProps {
		thread: PullRequestThread;
	}

	let { thread }: PullRequestThreadProps = $props();

	// Outdated threads (no longer on the current diff) start collapsed to reduce
	// noise; a user toggle overrides that default.
	let userCollapsed = $state<boolean | null>(null);
	const collapsed = $derived(userCollapsed ?? thread.isOutdated);

	const location = $derived(thread.line > 0 ? `${thread.path}:${thread.line}` : thread.path);
	const commentCount = $derived(thread.comments.length);
</script>

<div class="my-1 rounded-md border border-border bg-card text-card-foreground shadow-sm">
	<div
		class="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs text-muted-foreground"
		class:border-b-0={collapsed}
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
			onclick={() => (userCollapsed = !collapsed)}
			aria-expanded={!collapsed}
		>
			{#if collapsed}
				<ChevronRight class="h-3 w-3 flex-shrink-0" />
			{:else}
				<ChevronDown class="h-3 w-3 flex-shrink-0" />
			{/if}
			<span class="truncate font-mono">{location}</span>
			{#if thread.isOutdated}
				<span
					class="inline-flex flex-shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium"
				>
					<History class="h-3 w-3" />
					{m.pull_request_outdated()}
				</span>
			{/if}
			{#if collapsed}
				<span class="flex-shrink-0 text-[10px]">
					{m.pull_request_comment_count({ count: commentCount })}
				</span>
			{/if}
		</button>
	</div>
	{#if !collapsed}
		<ul class="divide-y divide-border">
			{#each thread.comments as comment (comment.id)}
				<li class="px-3 py-2">
					<div class="mb-0.5 text-xs font-semibold text-foreground">{comment.author}</div>
					<Markdown source={comment.body} class="markdown-body prose prose-sm max-w-none text-xs" />
				</li>
			{/each}
		</ul>
	{/if}
</div>
