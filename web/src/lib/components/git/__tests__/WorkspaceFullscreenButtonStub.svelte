<script lang="ts">
	import type { HostId } from '$lib/workspace/surface-types.js';

	let { host }: { host: HostId } = $props();
</script>

<button type="button" aria-label="Fullscreen" data-workspace-fullscreen-toggle={host}></button>
