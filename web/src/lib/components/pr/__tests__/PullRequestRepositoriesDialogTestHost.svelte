<script lang="ts">
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { onDestroy } from 'svelte';
	import { setMinuteClock } from '$lib/context';
	import { MinuteClockStore } from '$lib/stores/minute-clock.svelte.js';
	import type { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte';
	import PullRequestRepositoriesDialog from '../PullRequestRepositoriesDialog.svelte';

	let { reviews }: { reviews: PullRequestReviewsStore } = $props();
	setExecutorsTestContext();
	const minuteClock = new MinuteClockStore();
	setMinuteClock(minuteClock);
	onDestroy(() => minuteClock.destroy());
</script>

<PullRequestRepositoriesDialog
	{reviews}
	onOpenChat={() => {}}
	onClose={() => {}}
/>
