<script lang="ts">
	import type { PullRequestReviewInboxEntry } from '$shared/pull-request-reviews';
	import { cn } from '$lib/utils/cn';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';
	import * as m from '$lib/paraglide/messages.js';
	import PullRequestReviewChip from './PullRequestReviewChip.svelte';
	import PullRequestChecksStateIcon from './PullRequestChecksStateIcon.svelte';
	import PullRequestStateIcon from './PullRequestStateIcon.svelte';
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
	const reference = $derived(
		repositoryName
			? `${repositoryName.split('/').at(-1)} #${entry.pull.number}`
			: `#${entry.pull.number}`,
	);
</script>

<!-- A leading state icon and a trailing signal cluster let a row be triaged without reading its text. -->
<button
	type="button"
	class={cn(
		'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:py-2.5',
		selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
	)}
	onclick={onSelect}
	aria-current={selected}
	data-pr-inbox-row={`${entry.repositoryId}#${entry.pull.number}`}
>
	<PullRequestStateIcon
		state={entry.pull.state}
		isDraft={entry.pull.isDraft}
		class="mt-px h-4 w-4 pointer-coarse:mt-0.5"
	/>
	<span class="flex min-w-0 flex-1 flex-col gap-1">
		<span class="line-clamp-2 text-[13px] leading-snug text-foreground pointer-coarse:text-sm">
			{entry.pull.title}
			{#if entry.pull.isDraft}
				<span class="text-xs text-muted-foreground">({m.pull_request_draft()})</span>
			{/if}
		</span>
		<span class="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
			<span class="shrink-0 tabular-nums">{reference}</span>
			<span aria-hidden="true">·</span>
			<span class="min-w-0 truncate">{entry.pull.author}</span>
			{#if age}
				<span aria-hidden="true">·</span>
				<time class="shrink-0" datetime={entry.pull.updatedAt} title={age.tooltip}>{age.label}</time
				>
			{/if}
			<span class="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
				<PullRequestChecksStateIcon checksState={entry.pull.checksState} class="h-3.5 w-3.5" />
				{#if chip}
					<PullRequestReviewChip {chip} />
				{/if}
			</span>
		</span>
	</span>
</button>
