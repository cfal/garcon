<script lang="ts">
	import { onDestroy } from 'svelte';
	// LCS-based line diff viewer with color-coded additions/removals.

	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import * as m from '$lib/paraglide/messages.js';
	import { ChatClipboardFeedback } from '../../chat-clipboard-feedback.svelte.js';
	import { buildChatToolDiff } from './chat-tool-diff';

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
		showHeader = true,
	}: DiffViewerProps = $props();

	let badgeClasses = $derived(
		badgeColor === 'green'
			? 'bg-status-success/30 text-status-success-foreground border border-status-success-border'
			: 'bg-status-neutral/30 text-status-neutral-foreground border border-status-neutral-border',
	);

	let diff = $derived(buildChatToolDiff(oldContent ?? '', newContent ?? ''));

	const clipboard = new ChatClipboardFeedback();
	onDestroy(() => clipboard.reset());

	function handleCopyPath(): Promise<void> {
		return clipboard.copy(filePath);
	}
</script>

<div class="border border-border rounded overflow-hidden">
	{#if showHeader}
		<!-- Header -->
		<div class="flex items-center justify-between px-2.5 py-1 bg-muted/40 border-b border-border">
			<div class="flex items-center gap-1.5 min-w-0">
				{#if onFileClick}
					<button
						type="button"
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
				<button
					type="button"
					onclick={handleCopyPath}
					class="p-0.5 rounded transition-colors shrink-0 {clipboard.copied
						? 'text-status-success-foreground'
						: 'text-muted-foreground/60 hover:text-foreground hover:bg-accent'}"
					title={clipboard.copied ? m.git_file_path_copied_short() : m.git_file_path_copy()}
					aria-label={clipboard.copied ? m.git_file_path_copied() : m.git_file_path_copy()}
				>
					{#if clipboard.copied}
						<Check class="w-3 h-3" />
					{:else}
						<Copy class="w-3 h-3" />
					{/if}
				</button>
			</div>
			<span class="text-[10px] font-medium px-1.5 py-px rounded {badgeClasses} flex-shrink-0 ml-2">
				{badge}
			</span>
		</div>
	{/if}

	<!-- Diff lines -->
	<div class="typography-code-diff typography-inline-diff text-[11px] font-mono leading-[18px]">
		{#if diff.kind === 'too-large'}
			<div class="px-2.5 py-2 text-muted-foreground">
				{m.chat_tool_diff_too_large()}
			</div>
		{:else}
			{#each diff.lines as line, i (i)}
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
		{/if}
	</div>
</div>
