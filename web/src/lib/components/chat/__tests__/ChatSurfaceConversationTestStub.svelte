<script lang="ts">
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';

	let {
		subagentToolbar,
		reserveTopFloatingToolbar,
		onRegisterPrepareHide,
	}: {
		subagentToolbar: SubagentToolbarState;
		reserveTopFloatingToolbar: boolean;
		onRegisterPrepareHide?: (prepare: (() => void) | null) => void;
	} = $props();

	let prepareHideCount = $state(0);
	$effect(() => {
		onRegisterPrepareHide?.(() => {
			prepareHideCount += 1;
		});
		return () => onRegisterPrepareHide?.(null);
	});
</script>

<div
	data-testid="conversation-workspace-stub"
	data-has-subagent-toolbar={Boolean(subagentToolbar)}
	data-reserve-top-floating-toolbar={reserveTopFloatingToolbar}
	data-prepare-hide-count={prepareHideCount}
></div>
