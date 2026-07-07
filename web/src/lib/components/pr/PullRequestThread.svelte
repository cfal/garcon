<script lang="ts">
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import History from '@lucide/svelte/icons/history';
	import type { PullRequestThread } from '$lib/api/pull-requests';

	interface PullRequestThreadProps {
		thread: PullRequestThread;
		onAddress: () => void;
	}

	let { thread, onAddress }: PullRequestThreadProps = $props();

	const location = $derived(thread.line > 0 ? `${thread.path}:${thread.line}` : thread.path);
</script>

<div class="my-1 rounded-md border border-border bg-card text-card-foreground shadow-sm">
	<div
		class="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
	>
		<span class="flex min-w-0 items-center gap-1.5">
			<span class="truncate font-mono">{location}</span>
			{#if thread.isOutdated}
				<span
					class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
				>
					<History class="h-3 w-3" />
					Outdated
				</span>
			{/if}
		</span>
		<button
			type="button"
			class="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			onclick={onAddress}
			title="Send this comment to the agent to fix"
		>
			<Sparkles class="h-3 w-3" />
			Address with agent
		</button>
	</div>
	<ul class="divide-y divide-border">
		{#each thread.comments as comment (comment.id)}
			<li class="px-3 py-2">
				<div class="mb-0.5 text-xs font-semibold text-foreground">{comment.author}</div>
				<div class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{comment.body}</div>
			</li>
		{/each}
	</ul>
</div>
