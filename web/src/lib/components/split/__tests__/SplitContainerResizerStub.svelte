<script lang="ts">
	import type { SplitDirection } from '$lib/chat/split/split-layout.svelte.js';

	interface Props {
		direction: SplitDirection;
	}

	let { direction }: Props = $props();
</script>

<div data-testid="split-resizer-stub" data-direction={direction}></div>
