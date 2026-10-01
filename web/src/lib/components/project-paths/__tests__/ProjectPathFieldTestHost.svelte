<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import ProjectPathField from '$lib/components/project-paths/ProjectPathField.svelte';

	let {
		value = $bindable(''),
		onSubmit,
		...props
	}: ComponentProps<typeof ProjectPathField> & { onSubmit?: () => void } = $props();
	let input = $state<HTMLInputElement | null>(null);
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<form
	onsubmit={(event) => {
		event.preventDefault();
		onSubmit?.();
	}}
>
	<label for={props.id}>Project path</label>
	<ProjectPathField {...props} bind:value bind:ref={input}>
		{#snippet leading()}
			<button type="button">Executor selector</button>
		{/snippet}
		<button type="button">Additional action</button>
	</ProjectPathField>
	<button type="button" onclick={() => (value = '/replacement')}>Replace path</button>
	<button type="button" onclick={() => input?.focus()}>Focus path</button>
</form>
<output data-testid="path-value">{value}</output>
