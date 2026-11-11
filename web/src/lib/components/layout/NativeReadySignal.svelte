<script lang="ts">
	import { onMount } from 'svelte';
	import { getNativeLifecycle } from '$lib/native/lifecycle';

	onMount(() => {
		try {
			getNativeLifecycle()?.reportReady();
		} catch (error) {
			console.warn('Unable to report native page readiness.', error);
		}
	});
</script>
