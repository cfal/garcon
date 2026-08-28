<script lang="ts">
	import type { PaneId } from '$lib/workspace/surface-types.js';

	let { host }: { host: PaneId } = $props();
</script>

<button type="button" aria-label="Fullscreen" data-workspace-fullscreen-toggle={host}></button>
