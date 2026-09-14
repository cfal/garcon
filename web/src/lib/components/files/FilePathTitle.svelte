<script lang="ts">
	import CopyFilePathButton from './CopyFilePathButton.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let { path, fileName, dirty }: { path: string; fileName: string; dirty: boolean } = $props();
	let availableSize = $state<DOMRectReadOnly>();
	let requiredSize = $state<DOMRectReadOnly>();
	let controlsSize = $state<DOMRectReadOnly>();
	const title = $derived(
		requiredSize && availableSize && requiredSize.width <= availableSize.width ? path : fileName,
	);
</script>

<div
	class="relative flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground"
	bind:contentRect={availableSize}
	data-file-path-title
>
	<div class="pointer-events-none invisible absolute inset-0 overflow-hidden" aria-hidden="true">
		<div
			class="flex w-max items-center gap-1.5 whitespace-nowrap"
			bind:contentRect={requiredSize}
			data-file-path-title-measure
		>
			<span>{path}</span>
			<span style:width={`${controlsSize?.width ?? 0}px`}></span>
		</div>
	</div>
	<h2 class="min-w-0 truncate" title={path}>{title}</h2>
	<div class="flex shrink-0 items-center gap-1.5" bind:contentRect={controlsSize}>
		<CopyFilePathButton {path} />
		{#if dirty}
			<span class="text-status-warning-foreground" role="img" aria-label={m.file_session_unsaved()}
				>*</span
			>
		{/if}
	</div>
</div>
