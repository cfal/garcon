<script lang="ts">
	import FileWarning from '@lucide/svelte/icons/file-warning';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type {
		GitVirtualCollectionLimitRow,
		GitVirtualFileLimitRow,
		GitVirtualFilePlaceholderRow,
	} from '$lib/stores/git/git-virtual-review-document.svelte';

	type PlaceholderRow =
		| GitVirtualFilePlaceholderRow
		| GitVirtualFileLimitRow
		| GitVirtualCollectionLimitRow;

	interface GitVirtualPlaceholderRowProps {
		row: PlaceholderRow;
	}

	let { row }: GitVirtualPlaceholderRowProps = $props();

	let isLoading = $derived(row.kind === 'file-placeholder' && row.loadState === 'loading');
	let title = $derived.by(() => {
		if (row.kind === 'collection-limit') return row.title;
		if (row.kind === 'file-limit') return row.title;
		return row.loadState === 'loading' ? 'Loading diff' : 'Diff not loaded yet';
	});
	let message = $derived.by(() => {
		if (row.kind === 'collection-limit') return row.message;
		if (row.kind === 'file-limit') return row.message;
		return row.loadState === 'loading'
			? 'Rows near the viewport are being loaded.'
			: 'Scroll this file into view to request its rows.';
	});
</script>

<div class="flex min-h-[96px] items-start gap-2 px-3 py-5 text-xs text-muted-foreground" data-git-placeholder-row>
	{#if isLoading}
		<LoaderCircle class="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
	{:else}
		<FileWarning class="mt-0.5 h-4 w-4 shrink-0" />
	{/if}
	<div class="min-w-0">
		<div class="font-medium text-foreground">{title}</div>
		<div class="mt-0.5 break-words">{message}</div>
	</div>
</div>
