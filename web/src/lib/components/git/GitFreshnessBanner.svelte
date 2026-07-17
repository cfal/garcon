<script lang="ts">
	import RefreshRequiredBanner from '$lib/components/shared/RefreshRequiredBanner.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		isRefreshing: boolean;
		onRefresh: () => void | Promise<void>;
	}

	let { isRefreshing, onRefresh }: Props = $props();
</script>

<RefreshRequiredBanner
	message={m.git_freshness_changed()}
	refreshLabel={m.git_header_refresh()}
	{isRefreshing}
	{onRefresh}
/>
