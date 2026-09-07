<script lang="ts">
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';

	let {
		subagentToolbar,
		reserveMobileToolbar,
		isVisible,
		onRegisterPrepareHide,
	}: {
		subagentToolbar: SubagentToolbarState;
		reserveMobileToolbar: boolean;
		isVisible: boolean;
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
	data-reserve-mobile-toolbar={reserveMobileToolbar}
	data-visible={isVisible}
	data-prepare-hide-count={prepareHideCount}
></div>
