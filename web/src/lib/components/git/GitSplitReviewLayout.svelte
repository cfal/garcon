<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';
	import GitFileTreeResizeHandle from './GitFileTreeResizeHandle.svelte';

	let {
		wide,
		singlePane,
		fileTreeVisible,
		treeWidth,
		onResize,
		onResizeCommit,
		renderFiles,
		renderDiff,
		variant,
	}: {
		wide: boolean;
		singlePane: 'files' | 'diff';
		fileTreeVisible: boolean;
		treeWidth: number;
		onResize: (width: number) => void;
		onResizeCommit: (width: number) => void;
		renderFiles: Snippet;
		renderDiff: Snippet;
		variant: 'workbench' | 'document';
	} = $props();
	const filesHidden = $derived(wide ? !fileTreeVisible : singlePane !== 'files');
	const diffHidden = $derived(!wide && singlePane !== 'diff');
</script>

<div
	class={cn('relative min-h-0 flex-1 overflow-hidden', wide ? 'grid' : 'flex')}
	style:grid-template-columns={wide
		? fileTreeVisible
			? `${treeWidth}px 6px minmax(0,1fr)`
			: '0px minmax(0,1fr)'
		: undefined}
	style:grid-template-rows={wide ? 'minmax(0,1fr)' : undefined}
	data-git-wide-layout={variant === 'workbench' && wide ? '' : undefined}
	data-git-diff-document-panes={variant === 'document' ? '' : undefined}
>
	<div
		class={cn(
			'flex min-h-0 flex-col overflow-hidden bg-background',
			wide && fileTreeVisible && 'border-r border-border',
			!wide && 'absolute inset-0',
			filesHidden && 'invisible pointer-events-none',
		)}
		aria-hidden={filesHidden}
		inert={filesHidden}
		data-git-files-pane={variant === 'workbench' ? '' : undefined}
		data-git-history-files-pane={variant === 'document' ? '' : undefined}
	>
		{@render renderFiles()}
	</div>
	{#if wide && fileTreeVisible}
		<GitFileTreeResizeHandle width={treeWidth} {onResize} {onResizeCommit} />
	{/if}
	<div
		class={cn(
			'flex min-h-0 min-w-0 flex-col overflow-hidden',
			wide ? variant === 'document' && 'flex-1' : 'absolute inset-0 flex-1',
			diffHidden && 'invisible pointer-events-none',
		)}
		aria-hidden={diffHidden}
		inert={diffHidden}
		data-git-diff-pane={variant === 'workbench' ? '' : undefined}
		data-git-history-diff-pane={variant === 'document' ? '' : undefined}
	>
		{@render renderDiff()}
	</div>
</div>
