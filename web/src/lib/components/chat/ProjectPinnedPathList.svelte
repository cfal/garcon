<script lang="ts">
	interface ProjectPinnedPathListProps {
		pinnedProjectPaths: string[];
		selectedPath: string;
		onSelect: (path: string) => void;
		emptyLabel?: string;
		disabled?: boolean;
	}

	let {
		pinnedProjectPaths,
		selectedPath,
		onSelect,
		emptyLabel,
		disabled = false,
	}: ProjectPinnedPathListProps = $props();
</script>

{#if pinnedProjectPaths.length > 0}
	<div class="flex flex-wrap gap-2">
		{#each pinnedProjectPaths as pinnedPath (pinnedPath)}
			<button
				type="button"
				{disabled}
				class="rounded-md border px-2.5 py-1 text-xs transition-colors {selectedPath === pinnedPath
					? 'border-border bg-accent text-accent-foreground'
					: 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'} disabled:cursor-not-allowed disabled:opacity-50"
				onclick={() => onSelect(pinnedPath)}
			>
				<span class="block max-w-[70vw] truncate sm:max-w-[24rem]">{pinnedPath}</span>
			</button>
		{/each}
	</div>
{:else if emptyLabel}
	<p class="w-full rounded-md bg-muted/30 px-2.5 py-1 text-center text-xs text-muted-foreground">
		{emptyLabel}
	</p>
{/if}
