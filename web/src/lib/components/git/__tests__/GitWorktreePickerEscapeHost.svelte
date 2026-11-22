<script lang="ts">
	import { onMount } from 'svelte';
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import { pickerFixture, worktree } from './worktree-picker-fixture.js';
	import GitWorktreePickerModal from '../GitWorktreePickerModal.svelte';

	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);

	let isOpen = $state(true);
	const picker = pickerFixture({
		worktrees: [worktree('main', '2026-07-15T10:00:00.000Z', { isCurrent: true, isMain: true })],
		close: () => { isOpen = false; },
	});

	onMount(() => {
		const handleKeydown = (event: KeyboardEvent) => transientLayers.handleEscape(event);
		window.addEventListener('keydown', handleKeydown, { capture: true });
		return () => window.removeEventListener('keydown', handleKeydown, { capture: true });
	});
</script>

{#if isOpen}
	<GitWorktreePickerModal session={picker} />
{/if}
