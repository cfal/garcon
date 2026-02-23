<script lang="ts">
	// LCS-based line diff viewer with color-coded additions/removals.

	interface DiffLine {
		type: 'added' | 'removed';
		content: string;
		lineNum: number;
	}

	interface DiffViewerProps {
		oldContent: string;
		newContent: string;
		filePath: string;
		badge?: string;
		badgeColor?: 'gray' | 'green';
		onFileClick?: () => void;
		showHeader?: boolean;
	}

	let {
		oldContent,
		newContent,
		filePath,
		badge = 'Diff',
		badgeColor = 'gray',
		onFileClick,
		showHeader = true
	}: DiffViewerProps = $props();

	// Computes an LCS-based diff between old and new content strings.
	function computeDiff(oldStr: string, newStr: string): DiffLine[] {
		const oldLines = oldStr.split('\n');
		const newLines = newStr.split('\n');

		// Build LCS length table
		const m = oldLines.length;
		const n = newLines.length;
		const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (oldLines[i - 1] === newLines[j - 1]) {
					dp[i][j] = dp[i - 1][j - 1] + 1;
				} else {
					dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
				}
			}
		}

		// Backtrack to produce diff lines (only additions and removals shown)
		const result: DiffLine[] = [];
		let i = m;
		let j = n;

		const temp: DiffLine[] = [];
		while (i > 0 || j > 0) {
			if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
				i--;
				j--;
			} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
				temp.push({ type: 'added', content: newLines[j - 1], lineNum: j });
				j--;
			} else {
				temp.push({ type: 'removed', content: oldLines[i - 1], lineNum: i });
				i--;
			}
		}

		// Reverse to restore natural order
		for (let k = temp.length - 1; k >= 0; k--) {
			result.push(temp[k]);
		}

		return result;
	}

	let badgeClasses = $derived(
		badgeColor === 'green'
			? 'bg-status-success/30 text-status-success-foreground border border-status-success-border'
			: 'bg-status-neutral/30 text-status-neutral-foreground border border-status-neutral-border'
	);

	let diffLines = $derived(computeDiff(oldContent ?? '', newContent ?? ''));
</script>

<div class="border border-border rounded overflow-hidden">
	{#if showHeader}
		<!-- Header -->
		<div
			class="flex items-center justify-between px-2.5 py-1 bg-muted/40 border-b border-border"
		>
			{#if onFileClick}
					<button
						onclick={onFileClick}
						class="text-[11px] font-mono text-primary hover:text-primary/80 truncate cursor-pointer transition-colors"
					>
						{filePath}
					</button>
				{:else}
					<span class="text-[11px] font-mono text-foreground/80 truncate">
						{filePath}
					</span>
			{/if}
			<span
				class="text-[10px] font-medium px-1.5 py-px rounded {badgeClasses} flex-shrink-0 ml-2"
			>
				{badge}
			</span>
		</div>
	{/if}

	<!-- Diff lines -->
	<div class="text-[11px] font-mono leading-[18px]">
		{#each diffLines as line, i (i)}
			<div class="flex">
					<span
						class="w-6 text-center select-none flex-shrink-0 {line.type === 'removed'
							? 'bg-status-error/25 text-status-error-foreground'
							: 'bg-status-success/25 text-status-success-foreground'}"
					>
						{line.type === 'removed' ? '-' : '+'}
					</span>
					<span
						class="px-2 flex-1 whitespace-pre-wrap {line.type === 'removed'
							? 'bg-status-error/12 text-status-error-foreground'
							: 'bg-status-success/12 text-status-success-foreground'}"
					>
						{line.content}
					</span>
			</div>
		{/each}
	</div>
</div>
