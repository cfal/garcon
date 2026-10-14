<script lang="ts">
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import CircleMinus from '@lucide/svelte/icons/circle-minus';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import type { PullRequestCheck } from '$lib/api/pull-requests';
	import * as m from '$lib/paraglide/messages.js';
	import { checkStateClass, checksSummary, sortChecksForReview } from './pr-display';

	let { checks }: { checks: PullRequestCheck[] } = $props();

	const ordered = $derived(sortChecksForReview(checks));
	const summary = $derived(checksSummary(checks));
</script>

<div class="min-h-0 flex-1 overflow-y-auto">
	{#if checks.length === 0}
		<p class="px-4 py-8 text-center text-sm text-muted-foreground">
			{m.pull_request_checks_none()}
		</p>
	{:else}
		<p
			class="border-b border-border px-4 py-2 text-xs text-muted-foreground"
			data-pr-checks-summary
		>
			{summary}
		</p>
		<ul class="divide-y divide-border" data-pr-checks>
			{#each ordered as check, index (`${index}:${check.name}`)}
				<li class="flex items-center gap-2 px-4 py-2 text-sm">
					<span class={checkStateClass(check.state)}>
						{#if check.state === 'success'}
							<CircleCheck class="h-4 w-4" />
						{:else if check.state === 'failure'}
							<CircleX class="h-4 w-4" />
						{:else if check.state === 'pending'}
							<CircleDot class="h-4 w-4" />
						{:else}
							<CircleMinus class="h-4 w-4" />
						{/if}
					</span>
					<span class="min-w-0 flex-1 truncate text-foreground">{check.name}</span>
					{#if check.url}
						<a
							href={check.url}
							target="_blank"
							rel="noreferrer noopener"
							class="text-muted-foreground hover:text-foreground"
							aria-label={m.pull_request_check_details({ name: check.name })}
						>
							<ExternalLink class="h-3.5 w-3.5" />
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
