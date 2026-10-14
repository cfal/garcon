<script lang="ts">
	import type { PullRequestReviewInboxEntry } from '$shared/pull-request-reviews';
	import { cn } from '$lib/utils/cn';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';
	import * as m from '$lib/paraglide/messages.js';
	import PullRequestReviewChip from './PullRequestReviewChip.svelte';
	import { inboxReviewChip } from './pr-display';

	interface Props {
		entry: PullRequestReviewInboxEntry;
		repositoryName: string;
		selected: boolean;
		currentTime: Date;
		onSelect: () => void;
	}

	let { entry, repositoryName, selected, currentTime, onSelect }: Props = $props();

	const chip = $derived(inboxReviewChip(entry));
	const age = $derived(formatRelativeTimestamp(entry.pull.updatedAt, currentTime));
	const shortName = $derived(repositoryName.split('/').at(-1) ?? repositoryName);
</script>

<button
	type="button"
	class={cn(
		'flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
		selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
	)}
	onclick={onSelect}
	aria-current={selected}
	data-pr-inbox-row={`${entry.repositoryId}#${entry.pull.number}`}
>
	<span class="line-clamp-2 text-[13px] leading-snug text-foreground">
		{entry.pull.title}
		{#if entry.pull.isDraft}
			<span class="text-xs text-muted-foreground">({m.pull_request_draft()})</span>
		{/if}
	</span>
	<span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
		<span class="min-w-0 truncate"
			>{shortName} #{entry.pull.number} · {entry.pull.author}{#if age}<span class="mx-1">·</span><time
					datetime={entry.pull.updatedAt}
					title={age.tooltip}>{age.label}</time
				>{/if}</span
		>
		{#if chip}
			<PullRequestReviewChip {chip} class="ml-auto" />
		{/if}
	</span>
</button>
