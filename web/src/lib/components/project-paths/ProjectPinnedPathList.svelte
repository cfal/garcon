<script lang="ts">
	import { cn } from '$lib/utils/cn';
	interface ProjectPinnedPathListProps {
		class?: string;
		pinnedProjectPaths: string[];
		selectedPath: string;
		onSelect: (path: string) => void;
		emptyLabel?: string;
		disabled?: boolean;
		labelPrefix?: string;
		statusId?: string;
	}

	let {
		class: className,
		pinnedProjectPaths,
		selectedPath,
		onSelect,
		emptyLabel,
		disabled = false,
		labelPrefix,
		statusId,
	}: ProjectPinnedPathListProps = $props();
</script>

{#if pinnedProjectPaths.length > 0}
	<div class={cn('flex flex-wrap gap-2', className)}>
		{#each pinnedProjectPaths as pinnedPath (pinnedPath)}
			<button
				type="button"
				{disabled}
				aria-label={labelPrefix ? `${labelPrefix}: ${pinnedPath}` : pinnedPath}
				aria-describedby={statusId}
				aria-pressed={selectedPath === pinnedPath}
				title={pinnedPath}
				class="min-h-7 min-w-0 max-w-full rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring any-pointer-coarse:min-h-11 {selectedPath ===
				pinnedPath
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
