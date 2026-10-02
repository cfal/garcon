<script lang="ts">
	import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';

	let { getSelectableAgentIds }: { getSelectableAgentIds?: (executorId: string) => readonly SessionAgentId[] } = $props();
</script>

<button
	type="button"
	data-slot="scheduled-model-selector"
	data-selectable-agent-ids={getSelectableAgentIds?.('local').join(',')}
>
	Model selector
</button>
