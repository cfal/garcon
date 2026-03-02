<script lang="ts">
	// Renders a single commit row in the history view with an expandable
	// diff panel showing the commit's full patch.

	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import type { GitCommit } from '$lib/api/git';
	import { copyTextToClipboard } from '$lib/utils/clipboard';
	import { formatDiff } from './GitFileItem.svelte';

	interface GitCommitItemProps {
		commit: GitCommit;
		isExpanded: boolean;
		diff: string | undefined;
		isMobile: boolean;
		wrapText: boolean;
		onToggleExpanded: (hash: string) => void;
	}

	let {
		commit,
		isExpanded,
		diff,
		isMobile,
		wrapText,
		onToggleExpanded
	}: GitCommitItemProps = $props();

	let copiedHash = $state(false);
	let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;
	let shortHash = $derived(commit.hash.substring(0, 7));

	$effect(() => {
		return () => {
			if (copiedResetTimer) clearTimeout(copiedResetTimer);
		};
	});

	async function handleHashCopy(): Promise<void> {
		const copied = await copyTextToClipboard(commit.hash);
		if (!copied) return;
		copiedHash = true;
		if (copiedResetTimer) clearTimeout(copiedResetTimer);
		copiedResetTimer = setTimeout(() => {
			copiedHash = false;
			copiedResetTimer = null;
		}, 2000);
	}
</script>

<div class="border-b border-border last:border-0">
	<div class="w-full flex items-start justify-between gap-2 p-3 hover:bg-accent/50">
		<button
			type="button"
			class="flex min-w-0 flex-1 items-start text-left"
			onclick={() => onToggleExpanded(commit.hash)}
			aria-label="Toggle commit details"
		>
			<div class="mr-2 mt-1 p-0.5 hover:bg-accent rounded">
				{#if isExpanded}
					<ChevronDown class="w-3 h-3" />
				{:else}
					<ChevronRight class="w-3 h-3" />
				{/if}
			</div>
			<div class="flex-1 min-w-0">
				<p class="text-sm font-medium truncate">{commit.message}</p>
				<p class="text-xs text-muted-foreground mt-1">
					{commit.author} &bull; {commit.date}
				</p>
			</div>
		</button>
		<button
			type="button"
			class="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground flex-shrink-0 cursor-pointer select-none hover:text-foreground transition-colors"
			title={copiedHash ? 'Copied' : 'Copy commit hash'}
			onclick={handleHashCopy}
			data-copy-hash
			aria-label={copiedHash ? 'Copied commit hash' : 'Copy commit hash'}
		>
			<span>{shortHash}</span>
			<span class="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">
				{#if copiedHash}
					<Check class="w-3 h-3 text-status-success-foreground" />
				{:else}
					<Copy class="w-3 h-3" />
				{/if}
			</span>
		</button>
	</div>

	{#if isExpanded && diff}
		<div class="bg-muted/50">
			<div class="max-h-96 overflow-y-auto p-2">
				{#if commit.stats}
					<div class="text-xs font-mono text-muted-foreground mb-2">{commit.stats}</div>
				{/if}
				<pre class="text-xs font-mono {wrapText ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-x-auto'}">{@html formatDiff(diff)}</pre>
			</div>
		</div>
	{/if}
</div>
