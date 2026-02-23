<script lang="ts">
	// Renders a compact comma-separated list of clickable file names.

	interface FileListContentProps {
		files: string[];
		onFileClick?: (filePath: string) => void;
		title?: string;
	}

	let { files, onFileClick, title }: FileListContentProps = $props();

	function fileName(path: string): string {
		return path.split('/').pop() || path;
	}
</script>

<div>
	{#if title}
		<div class="text-[11px] text-muted-foreground mb-1">
			{title}
		</div>
	{/if}
	<div class="flex flex-wrap gap-x-1 gap-y-0.5 max-h-48 overflow-y-auto">
		{#each files as file, index (index)}
				<span class="inline-flex items-center">
					<button
						onclick={() => onFileClick?.(file)}
						class="text-[11px] font-mono text-primary hover:text-primary/80 hover:underline transition-colors"
						title={file}
					>
						{fileName(file)}
					</button>
					{#if index < files.length - 1}
						<span class="text-muted-foreground/60 text-[10px] ml-1">,</span>
					{/if}
				</span>
		{/each}
	</div>
</div>
