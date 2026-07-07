<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import type { PullRequestSummary } from '$lib/api/pull-requests';
	import { checksStateClass, prStateDotClass } from '$lib/components/pr/pr-display';
	import { cn } from '$lib/utils/cn';

	interface SidebarPRItemProps {
		pr: PullRequestSummary;
		selected: boolean;
		onSelect: () => void;
	}

	let { pr, selected, onSelect }: SidebarPRItemProps = $props();
</script>

<button
	type="button"
	class={cn(
		'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
		selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
	)}
	onclick={onSelect}
	aria-current={selected}
>
	<span class="flex min-w-0 items-center gap-1.5">
		<span
			class={cn('h-2 w-2 flex-shrink-0 rounded-full', prStateDotClass(pr.state, pr.isDraft))}
		></span>
		<span class="truncate text-xs font-medium text-foreground">
			<span class="text-muted-foreground">#{pr.number}</span>
			{pr.title}
		</span>
	</span>
	<span class="flex items-center gap-2 pl-3.5 text-[11px] text-muted-foreground">
		<span class="truncate">{pr.author}</span>
		{#if pr.checksState !== 'none'}
			<span class={cn('inline-flex items-center', checksStateClass(pr.checksState))}>
				{#if pr.checksState === 'passing'}
					<CircleCheck class="h-3 w-3" />
				{:else if pr.checksState === 'failing'}
					<CircleX class="h-3 w-3" />
				{:else}
					<CircleDot class="h-3 w-3" />
				{/if}
			</span>
		{/if}
		<span class="ml-auto flex-shrink-0 tabular-nums">
			<span class="text-git-added">+{pr.additions}</span>
			<span class="text-git-deleted">−{pr.deletions}</span>
		</span>
	</span>
</button>
