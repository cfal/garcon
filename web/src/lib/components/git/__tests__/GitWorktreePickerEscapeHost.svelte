<script lang="ts">
	import { onMount } from 'svelte';
	import { setTransientLayers } from '$lib/context';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import GitWorktreePickerModal from '../GitWorktreePickerModal.svelte';

	const transientLayers = new TransientLayerRegistry(new ChatInteractionGate());
	setTransientLayers(transientLayers);

	let isOpen = $state(true);

	onMount(() => {
		const handleKeydown = (event: KeyboardEvent) => transientLayers.handleEscape(event);
		window.addEventListener('keydown', handleKeydown, { capture: true });
		return () => window.removeEventListener('keydown', handleKeydown, { capture: true });
	});
</script>

{#if isOpen}
	<GitWorktreePickerModal
		worktrees={[
			{
				name: 'main',
				path: '/workspace/main',
				branch: 'main',
				isCurrent: true,
				isMain: true,
				isPathMissing: false,
				lastModifiedAt: '2026-07-15T10:00:00.000Z',
			},
		]}
		isLoading={false}
		isCreating={false}
		errorMessage={null}
		onSelect={() => {}}
		onCreate={() => {}}
		onRefresh={() => {}}
		onClose={() => (isOpen = false)}
	/>
{/if}
