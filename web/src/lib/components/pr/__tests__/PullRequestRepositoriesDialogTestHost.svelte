<script lang="ts">
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import type { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte';
	import PullRequestRepositoriesDialog from '../PullRequestRepositoriesDialog.svelte';

	let { reviews }: { reviews: PullRequestReviewsStore } = $props();
	setExecutorsTestContext();
</script>

<PullRequestRepositoriesDialog
	{reviews}
	onOpenChat={() => {}}
	onClose={() => {}}
/>
