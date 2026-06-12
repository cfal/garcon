<script lang="ts">
	// Coordinates file-level diff state and delegates row rendering to mode-specific tables.

	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { onDestroy } from 'svelte';
	import type { GitDiffTab, GitFileReviewData, GitReviewCommentDraft } from '$lib/api/git.js';
	import {
		type DiffMode,
		type GitDiffActionTarget,
	} from '$lib/stores/git-workbench.svelte.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import GitDiffLineContextMenu from './GitDiffLineContextMenu.svelte';
	import SplitDiffTable from './SplitDiffTable.svelte';
	import UnifiedDiffTable from './UnifiedDiffTable.svelte';
	import {
		buildCommentsByLineKey,
		buildSplitDiffRows,
		buildSplitDiffRowViews,
		buildUnifiedDiffRows,
		buildUnifiedDiffRowViews,
		getSelectableLineKeys,
		type GitDiffComposerDraft,
		type GitDiffLineContextTarget,
		type SplitDiffCellView,
		type UnifiedDiffRowView,
	} from './git-diff-rows';

	interface GitDiffViewerProps {
		filePath: string;
		reviewData: GitFileReviewData | null;
		activeTab: GitDiffTab;
		diffMode: DiffMode;
		fontSize?: number;
		contextLines?: number;
		selectedLineKeys: Set<string>;
		isLoading: boolean;
		readOnly?: boolean;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine?: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine?: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onAddComment: (side: 'before' | 'after', line: number) => void;
		comments?: GitReviewCommentDraft[];
		composerState?: GitDiffComposerDraft | null;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onEditComment?: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment?: (id: string) => void;
		onOpenInEditor?: (line: number) => void;
	}

	let {
		filePath,
		reviewData,
		activeTab,
		diffMode,
		fontSize = 12,
		contextLines = 5,
		selectedLineKeys,
		isLoading,
		readOnly = false,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddComment,
		comments,
		composerState,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onEditComment,
		onRemoveComment,
		onOpenInEditor,
	}: GitDiffViewerProps = $props();

	let lastClickedKey = $state<string | null>(null);
	let pathCopied = $state(false);
	let pathCopiedResetTimer: ReturnType<typeof setTimeout> | null = null;
	let lineContextMenu = $state<{
		open: (event: MouseEvent, target: GitDiffLineContextTarget | null) => void;
	} | null>(null);
	let diffViewport = $state<HTMLDivElement | null>(null);
	let editingCommentId = $state<string | null>(null);
	let editBody = $state('');

	let rowLineHeight = $derived(Math.max(Math.round(fontSize * 1.5), 16));
	let headerFontSize = $derived(Math.max(fontSize - 1, 10));
	let actionTarget = $derived<GitDiffActionTarget>({
		filePath,
		tab: activeTab,
		mode: activeTab === 'staged' ? 'unstage' : 'stage',
		contextLines,
	});
	let showLineActions = $derived(Boolean(onStageLine));
	let unifiedColCount = $derived(showLineActions ? 4 : 3);
	let splitColCount = $derived(showLineActions ? 6 : 4);

	let rows = $derived.by(() => buildUnifiedDiffRows(reviewData));
	let splitRows = $derived.by(() => buildSplitDiffRows(rows));
	let allLineKeys = $derived(readOnly ? [] : getSelectableLineKeys(rows, filePath, activeTab));
	let commentsByLineKey = $derived.by(() => buildCommentsByLineKey(comments ?? []));
	let composer = $derived<GitDiffComposerDraft | null>(
		composerState?.open && composerState.filePath === reviewData?.path ? composerState : null,
	);
	let unifiedRowViews = $derived.by(() =>
		buildUnifiedDiffRowViews({
			rows,
			filePath,
			activeTab,
			readOnly,
			selectedLineKeys,
			commentsByLineKey,
			composerTarget: composer,
		}),
	);
	let splitRowViews = $derived.by(() =>
		buildSplitDiffRowViews({
			rows: splitRows,
			filePath,
			activeTab,
			readOnly,
			selectedLineKeys,
			commentsByLineKey,
			composerTarget: composer,
		}),
	);

	function clearPathCopiedResetTimer(): void {
		if (pathCopiedResetTimer === null) return;
		clearTimeout(pathCopiedResetTimer);
		pathCopiedResetTimer = null;
	}

	async function handleCopyPath(): Promise<void> {
		if (!reviewData) return;
		const didCopy = await copyToClipboard(reviewData.path);
		if (!didCopy) return;
		pathCopied = true;
		clearPathCopiedResetTimer();
		pathCopiedResetTimer = setTimeout(() => {
			pathCopied = false;
			pathCopiedResetTimer = null;
		}, 2000);
	}

	onDestroy(clearPathCopiedResetTimer);

	function toggleSelectionFromKey(event: MouseEvent | KeyboardEvent, key: string | null): void {
		if (readOnly || !key) return;
		if (event.shiftKey && lastClickedKey) {
			onSelectLineRange(lastClickedKey, key, allLineKeys);
		} else {
			onToggleLineSelection(key);
		}
		lastClickedKey = key;
	}

	function handleUnifiedLineClick(
		event: MouseEvent | KeyboardEvent,
		row: UnifiedDiffRowView,
	): void {
		toggleSelectionFromKey(event, row.selectionKey);
	}

	function handleUnifiedLineKeydown(event: KeyboardEvent, row: UnifiedDiffRowView): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleUnifiedLineClick(event, row);
		}
	}

	function handleSplitCellClick(
		event: MouseEvent | KeyboardEvent,
		cell: SplitDiffCellView,
	): void {
		toggleSelectionFromKey(event, cell.selectionKey);
	}

	function handleSplitCellKeydown(event: KeyboardEvent, cell: SplitDiffCellView): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleSplitCellClick(event, cell);
		}
	}

	function openLineContextMenu(
		event: MouseEvent,
		target: GitDiffLineContextTarget | null,
	): void {
		lineContextMenu?.open(event, target);
	}

	function startEditComment(comment: GitReviewCommentDraft): void {
		editingCommentId = comment.id;
		editBody = comment.body;
	}

	function cancelEditComment(): void {
		editingCommentId = null;
		editBody = '';
	}

	function saveEditComment(commentId: string): void {
		onEditComment?.(commentId, { body: editBody });
		cancelEditComment();
	}
</script>

<div class="flex-1 flex flex-col h-full overflow-hidden">
	{#if isLoading}
		<div class="flex-1 flex items-center justify-center text-muted-foreground">
			<ArrowUpDown class="w-5 h-5 animate-pulse mr-2" />
			<span class="text-sm">Loading diff...</span>
		</div>
	{:else if !reviewData}
		<div class="flex-1 flex items-center justify-center text-muted-foreground">
			<p class="text-sm">Select a file to view changes</p>
		</div>
	{:else if reviewData.isBinary}
		<div class="flex-1 flex items-center justify-center text-muted-foreground">
			<p class="text-sm">Binary file -- cannot display diff</p>
		</div>
	{:else if reviewData.truncated}
		<div class="flex-1 flex items-center justify-center text-muted-foreground">
			<p class="text-sm">{reviewData.truncatedReason ?? 'File too large to display'}</p>
		</div>
	{:else if reviewData.error}
		<div class="flex-1 flex items-center justify-center text-status-error-foreground">
			<p class="text-sm">{reviewData.error}</p>
		</div>
	{:else if rows.length === 0}
		<div class="flex-1 flex items-center justify-center text-muted-foreground">
			<p class="text-sm">
				{readOnly ? 'No changed lines to review in this file' : 'No changes in this file'}
			</p>
		</div>
	{:else}
		<div class="px-3 py-1.5 border-b border-border bg-muted/30 flex items-center gap-2">
			<span class="font-mono text-foreground truncate" style:font-size={`${fontSize}px`}
				>{reviewData.path}</span
			>
			<button
				type="button"
				onclick={handleCopyPath}
				class="p-0.5 rounded transition-colors shrink-0 {pathCopied
					? 'text-status-success-foreground'
					: 'text-muted-foreground/60 hover:text-foreground hover:bg-accent'}"
				title={pathCopied ? 'Copied!' : 'Copy file path'}
				aria-label={pathCopied ? 'Path copied' : 'Copy file path'}
			>
				{#if pathCopied}
					<Check class="w-3 h-3" />
				{:else}
					<Copy class="w-3 h-3" />
				{/if}
			</button>
		</div>

		<div
			bind:this={diffViewport}
			class="flex-1 overflow-auto font-mono"
			style:font-size={`${fontSize}px`}
			style:line-height={`${rowLineHeight}px`}
		>
			{#if diffMode === 'split'}
				<SplitDiffTable
					rows={splitRowViews}
					{activeTab}
					{actionTarget}
					{readOnly}
					{headerFontSize}
					{rowLineHeight}
					colCount={splitColCount}
					{composer}
					{showLineActions}
					viewportRef={diffViewport}
					onCellClick={handleSplitCellClick}
					onCellKeydown={handleSplitCellKeydown}
					onOpenContextMenu={openLineContextMenu}
					{onStageHunk}
					{onUnstageHunk}
					{onStageLine}
					{onUnstageLine}
					{editingCommentId}
					{editBody}
					onStartEditComment={startEditComment}
					onCancelEditComment={cancelEditComment}
					onEditCommentBodyChange={(body) => {
						editBody = body;
					}}
					onSaveEditComment={saveEditComment}
					{onRemoveComment}
					{onComposerBodyChange}
					{onComposerSeverityChange}
					{onComposerSubmit}
					{onComposerClose}
				/>
			{:else}
				<UnifiedDiffTable
					rows={unifiedRowViews}
					{activeTab}
					{actionTarget}
					{readOnly}
					{headerFontSize}
					{rowLineHeight}
					colCount={unifiedColCount}
					{composer}
					{showLineActions}
					viewportRef={diffViewport}
					onLineClick={handleUnifiedLineClick}
					onLineKeydown={handleUnifiedLineKeydown}
					onOpenContextMenu={openLineContextMenu}
					{onStageHunk}
					{onUnstageHunk}
					{onStageLine}
					{onUnstageLine}
					{editingCommentId}
					{editBody}
					onStartEditComment={startEditComment}
					onCancelEditComment={cancelEditComment}
					onEditCommentBodyChange={(body) => {
						editBody = body;
					}}
					onSaveEditComment={saveEditComment}
					{onRemoveComment}
					{onComposerBodyChange}
					{onComposerSeverityChange}
					{onComposerSubmit}
					{onComposerClose}
				/>
			{/if}
		</div>
	{/if}

	<GitDiffLineContextMenu
		bind:this={lineContextMenu}
		{activeTab}
		{actionTarget}
		{readOnly}
		{onAddComment}
		{onStageHunk}
		{onUnstageHunk}
		{onStageLine}
		{onUnstageLine}
		{onOpenInEditor}
	/>
</div>
