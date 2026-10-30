<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import type { PullRequestSummary } from '$lib/api/pull-requests';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';
	import { checksStateClass, checksStateLabel } from './pr-display';

	interface PullRequestSummaryProps {
		pull: PullRequestSummary;
		currentTime: Date;
		// Makes the checks summary a shortcut to the Checks tab.
		onShowChecks: () => void;
	}

	let { pull, currentTime, onShowChecks }: PullRequestSummaryProps = $props();

	const checksLabel = $derived(checksStateLabel(pull.checksState));
	const age = $derived(formatRelativeTimestamp(pull.createdAt || pull.updatedAt, currentTime));
</script>

<h2 class="text-lg leading-snug font-semibold text-foreground">
	<a
		href={pull.url}
		target="_blank"
		rel="noreferrer noopener"
		class="group rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		title={m.pull_request_open_on_github()}
	>
		<!-- The word joiner keeps the icon on the line of the title's last word. -->
		{pull.title}<span aria-hidden="true"
			>&#8288;<ExternalLink
				class="ml-1.5 inline-block h-4 w-4 align-[-0.125em] text-muted-foreground group-hover:text-foreground"
			/></span
		>
	</a>
</h2>
<!-- Wraps so the branch drops to its own line instead of squeezing the meta on narrow widths. -->
<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
	<span class="font-medium text-foreground">{pull.author}</span>
	{#if age}<time datetime={pull.createdAt} title={age.tooltip}>{age.label}</time>{/if}
	{#if checksLabel}
		<button
			type="button"
			class="rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {checksStateClass(
				pull.checksState,
			)}"
			onclick={onShowChecks}
			data-pr-checks-shortcut>{checksLabel}</button
		>
	{/if}
	<span
		class="max-w-full min-w-0 truncate font-mono"
		title={`${pull.headRefName} → ${pull.baseRefName}`}
		data-pr-branches>{pull.headRefName} → {pull.baseRefName}</span
	>
</div>
