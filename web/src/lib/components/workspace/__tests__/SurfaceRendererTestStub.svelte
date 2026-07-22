<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getSurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import { surfaceRendererTestProbe } from './surface-renderer-test-probe.js';

	let {
		onClose,
		closeDisabled = false,
	}: {
		onClose?: () => void;
		closeDisabled?: boolean;
	} = $props();

	const unregister = getSurfaceFrameBridge().provideRenderer({
		attach: () => surfaceRendererTestProbe.attach(),
		detach: () => surfaceRendererTestProbe.detach(),
		focusPrimary: () => undefined,
	});

	onDestroy(unregister);
</script>

<div data-testid="surface-renderer-stub">Surface renderer</div>
{#if onClose}
	<button type="button" onclick={onClose} disabled={closeDisabled}>Close file</button>
{/if}
