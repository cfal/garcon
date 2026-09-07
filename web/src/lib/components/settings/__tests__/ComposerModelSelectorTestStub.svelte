<script lang="ts">
	import type { SessionAgentId } from '$lib/types/app';

	let { selectableAgentIds }: { selectableAgentIds?: readonly SessionAgentId[] } = $props();
</script>

<button
	type="button"
	data-slot="scheduled-model-selector"
	data-selectable-agent-ids={selectableAgentIds?.join(',')}
>
	Model selector
</button>
