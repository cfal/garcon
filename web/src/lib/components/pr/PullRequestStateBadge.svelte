<script lang="ts">
	import type { PullRequestSummary } from '$lib/api/pull-requests';
	import PullRequestStateIcon from './PullRequestStateIcon.svelte';
	import { prStateBadge } from './pr-display';

	let { pull }: { pull: Pick<PullRequestSummary, 'state' | 'isDraft'> } = $props();

	const badge = $derived(prStateBadge(pull.state, pull.isDraft));
</script>

<span
	class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium {badge.class}"
>
	<PullRequestStateIcon
		state={pull.state}
		isDraft={pull.isDraft}
		class="h-3.5 w-3.5 text-current"
	/>
	{badge.label}
</span>
