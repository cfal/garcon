<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	let { enabled = true }: { enabled?: boolean } = $props();
</script>

{#each [Position.Top, Position.Right, Position.Bottom, Position.Left] as side (side)}
	<Handle type="source" id={side} position={side} isConnectable={enabled} class="canvas-handle" />
{/each}
