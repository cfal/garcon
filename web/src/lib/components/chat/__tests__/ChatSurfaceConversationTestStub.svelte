<script lang="ts">
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';

	let {
		subagentToolbar,
		reserveTopFloatingToolbar,
	}: {
		subagentToolbar: SubagentToolbarState;
		reserveTopFloatingToolbar: boolean;
	} = $props();
</script>

<div
	data-testid="conversation-workspace-stub"
	data-has-subagent-toolbar={Boolean(subagentToolbar)}
	data-reserve-top-floating-toolbar={reserveTopFloatingToolbar}
></div>
