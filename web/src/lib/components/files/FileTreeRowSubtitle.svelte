<script lang="ts">
	import type { FileTreeEntry } from '$shared/file-contracts';
	import type { OptionalFileTreeColumnKey } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import {
		fileTreeFieldLabel,
		presentFileTreeDetail,
		type FileTreeDetailPresentation,
	} from './file-tree-entry-presentation.js';

	let {
		entry,
		keys,
	}: {
		entry: FileTreeEntry;
		keys: readonly OptionalFileTreeColumnKey[];
	} = $props();

	const availableDetails = $derived(
		keys
			.map((key) => presentFileTreeDetail(entry, key))
			.filter(
				(detail): detail is FileTreeDetailPresentation & { value: string } => detail.value !== null,
			),
	);
	const subtitleTitle = $derived(
		availableDetails
			.map((detail) => `${fileTreeFieldLabel(detail.key)}: ${detail.value}`)
			.join(' · '),
	);
</script>

<div
	class="flex min-w-0 items-center overflow-hidden whitespace-nowrap pl-[calc(var(--file-tree-disclosure-size)+1.5rem)] text-xs leading-4 text-muted-foreground"
	data-file-tree-subtitle
	title={subtitleTitle || m.filetree_no_details_available()}
>
	{#if availableDetails.length === 0}
		<span class="truncate">{m.filetree_no_details_available()}</span>
	{:else}
		{#each availableDetails as detail, index (detail.key)}
			{#if index > 0}
				<span class="mx-1 shrink-0" aria-hidden="true">·</span>
			{/if}
			<span class:font-mono={detail.monospace} class="truncate">
				<span class="sr-only">{fileTreeFieldLabel(detail.key)}: </span>
				{detail.value}
			</span>
		{/each}
	{/if}
</div>
