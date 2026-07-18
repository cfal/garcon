<script lang="ts">
	import RefreshRequiredBanner from '$lib/components/shared/RefreshRequiredBanner.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		changed,
		isRefreshing,
		refreshError = null,
		onRefresh,
	}: {
		changed: boolean;
		isRefreshing: boolean;
		refreshError?: string | null;
		onRefresh: () => void | Promise<void>;
	} = $props();
</script>

<RefreshRequiredBanner
	message={changed ? m.file_session_changed_on_disk() : m.file_session_refresh_error()}
	refreshLabel={m.file_session_refresh()}
	{isRefreshing}
	refreshError={refreshError
		? m.file_session_refresh_failed({ message: refreshError })
		: null}
	{onRefresh}
/>
