<script lang="ts">
	// Diff viewer that renders structured diff ops in unified or split mode.
	// Supports line selection for staging and inline comment placement.

	import Plus from '@lucide/svelte/icons/plus';
	import Minus from '@lucide/svelte/icons/minus';
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type { GitFileReviewData, GitReviewCommentDraft, GitDiffTab } from '$lib/api/git.js';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';

	interface RenderedDiffRow {
		kind: 'context' | 'add' | 'del' | 'hunk-header';
		beforeLine: number | null;
		afterLine: number | null;
		beforeText: string;
		afterText: string;
		hunkId?: string;
		hunkIndex: number;
		diffLineIndex: number;
	}

	// Split mode pairs left (before) and right (after) columns.
	interface SplitRow {
		isHeader: boolean;
		headerText?: string;
		hunkIndex?: number;
		left: { kind: 'context' | 'del' | 'empty'; line: number | null; text: string; diffLineIndex: number } | null;
		right: { kind: 'context' | 'add' | 'empty'; line: number | null; text: string; diffLineIndex: number } | null;
	}

	interface GitDiffViewerProps {
		reviewData: GitFileReviewData | null;
		activeTab: GitDiffTab;
		diffMode: DiffMode;
		fontSize?: number;
		selectedLineKeys: Set<string>;
		isLoading: boolean;
		readOnly?: boolean;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (hunkIndex: number) => void;
		onUnstageHunk: (hunkIndex: number) => void;
		onStageLine?: (diffLineIndex: number) => void;
		onUnstageLine?: (diffLineIndex: number) => void;
		onAddComment: (side: 'before' | 'after', line: number) => void;
		comments?: GitReviewCommentDraft[];
		composerState?: { open: boolean; filePath: string; side: 'before' | 'after'; line: number; body: string; severity: 'note' | 'warning' | 'blocker' } | null;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: 'note' | 'warning' | 'blocker') => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onEditComment?: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment?: (id: string) => void;
		onOpenInEditor?: (line: number) => void;
	}

	let {
		reviewData,
		activeTab,
		diffMode,
		fontSize = 12,
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
	let headerFontSize = $derived(Math.max(fontSize - 1, 10));
	let rowLineHeight = $derived(Math.max(Math.round(fontSize * 1.5), 16));

	// Build renderable rows from review data (unified mode)
	let rows = $derived.by(() => {
		if (!reviewData || reviewData.isBinary || reviewData.truncated) return [];

		const result: RenderedDiffRow[] = [];
		const beforeLines = reviewData.contentBefore?.split('\n') ?? [];
		const afterLines = reviewData.contentAfter?.split('\n') ?? [];
		let diffLineIdx = 0;

		for (let h = 0; h < reviewData.hunks.length; h++) {
			const hunk = reviewData.hunks[h];

			result.push({
				kind: 'hunk-header',
				beforeLine: null,
				afterLine: null,
				beforeText: hunk.header,
				afterText: '',
				hunkId: hunk.id,
				hunkIndex: h,
				diffLineIndex: -1,
			});

			for (let i = hunk.lineStartIndex; i <= hunk.lineEndIndex && i < reviewData.diffOps.length; i++) {
				const op = reviewData.diffOps[i];

				if (op.type === 'equal') {
					const bLine = op.before[0];
					const aLine = op.after[0];
					result.push({
						kind: 'context', beforeLine: bLine, afterLine: aLine,
						beforeText: beforeLines[bLine - 1] ?? '', afterText: afterLines[aLine - 1] ?? '',
						hunkId: hunk.id, hunkIndex: h, diffLineIndex: diffLineIdx++,
					});
				} else if (op.type === 'delete') {
					const bLine = op.before[0];
					result.push({
						kind: 'del', beforeLine: bLine, afterLine: null,
						beforeText: beforeLines[bLine - 1] ?? '', afterText: '',
						hunkId: hunk.id, hunkIndex: h, diffLineIndex: diffLineIdx++,
					});
				} else if (op.type === 'insert') {
					const aLine = op.after[0];
					result.push({
						kind: 'add', beforeLine: null, afterLine: aLine,
						beforeText: '', afterText: afterLines[aLine - 1] ?? '',
						hunkId: hunk.id, hunkIndex: h, diffLineIndex: diffLineIdx++,
					});
				}
			}
		}
		return result;
	});

	// Build split-mode paired rows from unified rows.
	let splitRows = $derived.by((): SplitRow[] => {
		if (diffMode !== 'split' || rows.length === 0) return [];

		const result: SplitRow[] = [];
		let i = 0;
		let currentHunkIndex = 0;

		while (i < rows.length) {
			const row = rows[i];

			if (row.kind === 'hunk-header') {
				currentHunkIndex = row.hunkIndex;
				result.push({ isHeader: true, headerText: row.beforeText, hunkIndex: row.hunkIndex, left: null, right: null });
				i++;
				continue;
			}

			if (row.kind === 'context') {
				result.push({
					isHeader: false,
					hunkIndex: currentHunkIndex,
					left: { kind: 'context', line: row.beforeLine, text: row.beforeText, diffLineIndex: row.diffLineIndex },
					right: { kind: 'context', line: row.afterLine, text: row.afterText || row.beforeText, diffLineIndex: row.diffLineIndex },
				});
				i++;
				continue;
			}

			// Collect consecutive del/add for pairing
			const dels: RenderedDiffRow[] = [];
			const adds: RenderedDiffRow[] = [];

			while (i < rows.length && rows[i].kind === 'del') {
				dels.push(rows[i]);
				i++;
			}
			while (i < rows.length && rows[i].kind === 'add') {
				adds.push(rows[i]);
				i++;
			}

			const maxLen = Math.max(dels.length, adds.length);
			for (let j = 0; j < maxLen; j++) {
				const d = dels[j];
				const a = adds[j];
				result.push({
					isHeader: false,
					hunkIndex: currentHunkIndex,
					left: d
						? { kind: 'del', line: d.beforeLine, text: d.beforeText, diffLineIndex: d.diffLineIndex }
						: { kind: 'empty', line: null, text: '', diffLineIndex: -1 },
					right: a
						? { kind: 'add', line: a.afterLine, text: a.afterText, diffLineIndex: a.diffLineIndex }
						: { kind: 'empty', line: null, text: '', diffLineIndex: -1 },
				});
			}
		}
		return result;
	});

	// All selectable diff line keys for range selection
	let allLineKeys = $derived(
		readOnly
			? []
			: rows
				.filter((r) => r.kind === 'add' || r.kind === 'del')
				.map((r) => `${r.kind === 'del' ? 'before' : 'after'}:${r.diffLineIndex}`),
	);

	function lineKey(row: RenderedDiffRow): string {
		return `${row.kind === 'del' ? 'before' : 'after'}:${row.diffLineIndex}`;
	}

	function handleLineClick(e: MouseEvent | KeyboardEvent, row: RenderedDiffRow): void {
		if (readOnly) return;
		if (row.kind !== 'add' && row.kind !== 'del') return;
		const key = lineKey(row);

		if (e.shiftKey && lastClickedKey) {
			onSelectLineRange(lastClickedKey, key, allLineKeys);
		} else {
			onToggleLineSelection(key);
		}
		lastClickedKey = key;
	}

	function handleLineKeyDown(e: KeyboardEvent, row: RenderedDiffRow): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleLineClick(e, row);
		}
	}

	function handleSplitCellClick(e: MouseEvent | KeyboardEvent, side: 'before' | 'after', diffLineIndex: number, kind: string): void {
		if (readOnly) return;
		if (kind !== 'del' && kind !== 'add') return;
		const key = `${side}:${diffLineIndex}`;

		if (e.shiftKey && lastClickedKey) {
			onSelectLineRange(lastClickedKey, key, allLineKeys);
		} else {
			onToggleLineSelection(key);
		}
		lastClickedKey = key;
	}

	function handleSplitCellKeyDown(e: KeyboardEvent, side: 'before' | 'after', diffLineIndex: number, kind: string): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleSplitCellClick(e, side, diffLineIndex, kind);
		}
	}

	function isLineSelected(row: RenderedDiffRow): boolean {
		if (readOnly) return false;
		if (row.kind !== 'add' && row.kind !== 'del') return false;
		return selectedLineKeys.has(lineKey(row));
	}

	function isSplitCellSelected(side: 'before' | 'after', diffLineIndex: number, kind: string): boolean {
		if (readOnly) return false;
		if (kind !== 'del' && kind !== 'add') return false;
		return selectedLineKeys.has(`${side}:${diffLineIndex}`);
	}

	// Column counts for colspan on inline comment/composer rows
	let unifiedColCount = $derived(onStageLine ? 4 : 3);
	let splitColCount = $derived(onStageLine ? 6 : 4);

	// Lookup map: `${side}:${line}` -> comments anchored at that location
	let commentsByLineKey = $derived.by(() => {
		const map = new Map<string, GitReviewCommentDraft[]>();
		for (const c of comments ?? []) {
			const key = `${c.side}:${c.line}`;
			const arr = map.get(key) ?? [];
			arr.push(c);
			map.set(key, arr);
		}
		return map;
	});

	// Whether the composer targets a specific side+line in the current file
	function isComposerForCell(side: 'before' | 'after', line: number | null): boolean {
		if (!composerState?.open || line == null) return false;
		if (composerState.filePath !== reviewData?.path) return false;
		return composerState.side === side && composerState.line === line;
	}

	// Whether the composer targets any side/line within a unified diff row
	function isComposerForRow(row: RenderedDiffRow): boolean {
		if (row.kind === 'del') return isComposerForCell('before', row.beforeLine);
		if (row.kind === 'add') return isComposerForCell('after', row.afterLine);
		if (row.kind === 'context') {
			return isComposerForCell('before', row.beforeLine) || isComposerForCell('after', row.afterLine);
		}
		return false;
	}

	// Collects all comments anchored to a unified diff row
	function getLineComments(row: RenderedDiffRow): GitReviewCommentDraft[] {
		const result: GitReviewCommentDraft[] = [];
		if ((row.kind === 'del' || row.kind === 'context') && row.beforeLine != null) {
			result.push(...(commentsByLineKey.get(`before:${row.beforeLine}`) ?? []));
		}
		if ((row.kind === 'add' || row.kind === 'context') && row.afterLine != null) {
			result.push(...(commentsByLineKey.get(`after:${row.afterLine}`) ?? []));
		}
		return result;
	}

	// Collects comments for a split-mode row (both sides)
	function getSplitRowComments(srow: SplitRow): GitReviewCommentDraft[] {
		const result: GitReviewCommentDraft[] = [];
		if (srow.left?.line != null) result.push(...(commentsByLineKey.get(`before:${srow.left.line}`) ?? []));
		if (srow.right?.line != null) result.push(...(commentsByLineKey.get(`after:${srow.right.line}`) ?? []));
		return result;
	}

	function severityColor(severity: string): string {
		switch (severity) {
			case 'blocker': return 'text-status-error-foreground bg-status-error/10';
			case 'warning': return 'text-status-warning-foreground bg-status-warning/10';
			default: return 'text-status-info-foreground bg-status-info/10';
		}
	}

	// Inline edit state for existing comments
	let editingCommentId = $state<string | null>(null);
	let editBody = $state('');

	// Auto-scroll and auto-focus for the inline composer
	let composerRowEl = $state<HTMLElement | null>(null);

	$effect(() => {
		if (composerRowEl && composerState?.open) {
			composerRowEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			const textarea = composerRowEl.querySelector('textarea');
			textarea?.focus();
		}
	});

	function handleComposerKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (composerState?.body?.trim()) onComposerSubmit?.();
		}
		if (e.key === 'Escape') onComposerClose?.();
	}

	function rowBgClass(row: RenderedDiffRow): string {
		if (isLineSelected(row)) return 'bg-interactive-accent/20';
		if (isComposerForRow(row)) return 'bg-interactive-accent/10';
		switch (row.kind) {
			case 'add': return 'bg-diff-add';
			case 'del': return 'bg-diff-del';
			case 'hunk-header': return 'bg-diff-hunk-header';
			default: return '';
		}
	}

	function splitCellBg(kind: string, side: 'before' | 'after', diffLineIndex: number, line: number | null = null): string {
		if (isSplitCellSelected(side, diffLineIndex, kind)) return 'bg-interactive-accent/20';
		if (line != null && isComposerForCell(side, line)) return 'bg-interactive-accent/10';
		switch (kind) {
			case 'add': return 'bg-diff-add';
			case 'del': return 'bg-diff-del';
			default: return '';
		}
	}

	function lineNumClass(row: RenderedDiffRow): string {
		switch (row.kind) {
			case 'add': return 'text-diff-add-line-num';
			case 'del': return 'text-diff-del-line-num';
			default: return 'text-muted-foreground/50';
		}
	}

	function splitLineNumClass(kind: string): string {
		switch (kind) {
			case 'add': return 'text-diff-add-line-num';
			case 'del': return 'text-diff-del-line-num';
			default: return 'text-muted-foreground/50';
		}
	}

	// Context menu state for line-level actions
	let ctxMenu = $state<{
		open: boolean;
		x: number;
		y: number;
		side: 'before' | 'after';
		line: number | null;
		hunkIndex: number;
		diffLineIndex: number;
		rowKind: 'add' | 'del' | 'context';
	}>({ open: false, x: 0, y: 0, side: 'before', line: null, hunkIndex: -1, diffLineIndex: -1, rowKind: 'context' });

	function openCtxMenu(
		e: MouseEvent,
		side: 'before' | 'after',
		line: number | null,
		hunkIndex: number,
		diffLineIndex: number,
		rowKind: 'add' | 'del' | 'context',
	): void {
		e.preventDefault();
		e.stopPropagation();
		const x = Math.min(e.clientX, window.innerWidth - 180);
		const y = Math.min(e.clientY, window.innerHeight - 200);
		ctxMenu = { open: true, x, y, side, line, hunkIndex, diffLineIndex, rowKind };
	}

	function closeCtxMenu(): void {
		ctxMenu = { ...ctxMenu, open: false };
	}

	function handleUnifiedCtxMenu(e: MouseEvent, row: RenderedDiffRow): void {
		if (row.kind === 'hunk-header') return;
		const side: 'before' | 'after' = row.kind === 'del' ? 'before' : 'after';
		const line = row.kind === 'del' ? row.beforeLine : (row.afterLine ?? row.beforeLine);
		openCtxMenu(e, side, line, row.hunkIndex, row.diffLineIndex, row.kind as 'add' | 'del' | 'context');
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
			<p class="text-sm">{readOnly ? 'No changed lines to review in this file' : 'No changes in this file'}</p>
		</div>
	{:else}
		<!-- File path header -->
		<div class="px-3 py-1.5 border-b border-border bg-muted/30 flex items-center gap-2">
			<span class="font-mono text-foreground truncate" style:font-size={`${fontSize}px`}>{reviewData.path}</span>
		</div>

		<!-- Diff content -->
		<div
			class="flex-1 overflow-auto font-mono"
			style:font-size={`${fontSize}px`}
			style:line-height={`${rowLineHeight}px`}
		>
			{#if diffMode === 'split'}
				<!-- Split diff -->
				<table class="w-full border-collapse">
					<tbody>
						{#each splitRows as srow, idx (idx)}
							{#if srow.isHeader}
								<tr class="bg-diff-hunk-header">
									<td colspan={onStageLine ? 6 : 4} class="px-2 py-1 text-muted-foreground" style:font-size={`${headerFontSize}px`}>
										<div class="flex items-center gap-2">
											<span class="flex-1 truncate">{srow.headerText}</span>
											{#if !readOnly}
												{#if activeTab === 'unstaged'}
													<button
														onclick={() => onStageHunk(srow.hunkIndex!)}
														class="px-1.5 py-0.5 text-[10px] rounded bg-git-added/20 text-git-added hover:bg-git-added/30 transition-colors"
														title="Stage hunk"
													>
														<Plus class="w-3 h-3 inline" /> Stage
													</button>
												{:else}
													<button
														onclick={() => onUnstageHunk(srow.hunkIndex!)}
														class="px-1.5 py-0.5 text-[10px] rounded bg-git-deleted/20 text-git-deleted hover:bg-git-deleted/30 transition-colors"
														title="Unstage hunk"
													>
														<Minus class="w-3 h-3 inline" /> Unstage
													</button>
												{/if}
											{/if}
										</div>
									</td>
								</tr>
							{:else}
								<tr
									class="select-none"
									oncontextmenu={(e) => {
										if (srow.left?.kind === 'empty' && srow.right?.kind === 'empty') return;
										const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
										const isRight = e.clientX > rect.left + rect.width / 2;
										const cell = isRight ? srow.right : srow.left;
										if (!cell || cell.kind === 'empty') return;
										const side: 'before' | 'after' = isRight ? 'after' : 'before';
										const rowKind = cell.kind === 'del' ? 'del' : cell.kind === 'add' ? 'add' : 'context';
										openCtxMenu(e, side, cell.line, srow.hunkIndex ?? -1, cell.diffLineIndex, rowKind);
									}}
								>
									<!-- Left gutter: stage/unstage -->
									{#if onStageLine}
										<td class="w-7 select-none border-r border-border/30 p-0 {splitCellBg(srow.left?.kind ?? '', 'before', srow.left?.diffLineIndex ?? -1, srow.left?.line ?? null)}">
											<div class="flex items-center justify-center leading-5">
												{#if srow.left?.kind === 'del'}
													{#if activeTab === 'unstaged'}
														<button
															onclick={(e) => { e.stopPropagation(); onStageLine?.(srow.left!.diffLineIndex); }}
															class="flex items-center justify-center text-muted-foreground/30 hover:text-git-added hover:bg-git-added/20 transition-colors rounded p-0.5"
															title="Stage line"
														>
															<Plus class="w-2.5 h-2.5" />
														</button>
													{:else}
														<button
															onclick={(e) => { e.stopPropagation(); onUnstageLine?.(srow.left!.diffLineIndex); }}
															class="flex items-center justify-center text-muted-foreground/30 hover:text-git-deleted hover:bg-git-deleted/20 transition-colors rounded p-0.5"
															title="Unstage line"
														>
															<Minus class="w-2.5 h-2.5" />
														</button>
													{/if}
												{/if}
											</div>
										</td>
									{/if}
									<!-- Left line number (tap to open context menu) -->
									<td
										class="w-10 text-right pr-1.5 select-none {splitLineNumClass(srow.left?.kind ?? '')} border-r border-border/30 {splitCellBg(srow.left?.kind ?? '', 'before', srow.left?.diffLineIndex ?? -1, srow.left?.line ?? null)} {srow.left?.line != null ? 'cursor-pointer hover:bg-interactive-accent/10' : ''}"
										onclick={(e) => {
											if (!srow.left || srow.left.line == null) return;
											e.stopPropagation();
											const rowKind = srow.left.kind === 'del' ? 'del' as const : 'context' as const;
											openCtxMenu(e, 'before', srow.left.line, srow.hunkIndex ?? -1, srow.left.diffLineIndex, rowKind);
										}}
									>
										{srow.left?.line ?? ''}
									</td>
									<td
										class="w-1/2 pl-2 pr-1 whitespace-pre-wrap break-all
											{srow.left?.kind === 'del' && !readOnly ? 'cursor-pointer' : ''}
											{splitCellBg(srow.left?.kind ?? '', 'before', srow.left?.diffLineIndex ?? -1, srow.left?.line ?? null)}"
										tabindex={srow.left?.kind === 'del' && !readOnly ? 0 : -1}
										role={srow.left?.kind === 'del' && !readOnly ? 'button' : undefined}
										onclick={(e) => { if (srow.left?.kind === 'del') handleSplitCellClick(e, 'before', srow.left.diffLineIndex, 'del'); }}
										onkeydown={(e) => { if (srow.left?.kind === 'del') handleSplitCellKeyDown(e, 'before', srow.left!.diffLineIndex, 'del'); }}
									>
										{#if srow.left?.kind === 'del'}
											<span class="text-diff-del-fg select-text">-{srow.left.text}</span>
										{:else if srow.left?.kind === 'context'}
											<span class="text-foreground select-text">&nbsp;{srow.left.text}</span>
										{:else}
											&nbsp;
										{/if}
									</td>

									<!-- Right gutter: stage/unstage -->
									{#if onStageLine}
										<td class="w-7 select-none border-l border-r border-border/30 p-0 {splitCellBg(srow.right?.kind ?? '', 'after', srow.right?.diffLineIndex ?? -1, srow.right?.line ?? null)}">
											<div class="flex items-center justify-center leading-5">
												{#if srow.right?.kind === 'add'}
													{#if activeTab === 'unstaged'}
														<button
															onclick={(e) => { e.stopPropagation(); onStageLine?.(srow.right!.diffLineIndex); }}
															class="flex items-center justify-center text-muted-foreground/30 hover:text-git-added hover:bg-git-added/20 transition-colors rounded p-0.5"
															title="Stage line"
														>
															<Plus class="w-2.5 h-2.5" />
														</button>
													{:else}
														<button
															onclick={(e) => { e.stopPropagation(); onUnstageLine?.(srow.right!.diffLineIndex); }}
															class="flex items-center justify-center text-muted-foreground/30 hover:text-git-deleted hover:bg-git-deleted/20 transition-colors rounded p-0.5"
															title="Unstage line"
														>
															<Minus class="w-2.5 h-2.5" />
														</button>
													{/if}
												{/if}
											</div>
										</td>
									{/if}
									<!-- Right line number (tap to open context menu) -->
									<td
										class="w-10 text-right pr-1.5 select-none {splitLineNumClass(srow.right?.kind ?? '')} border-l border-r border-border/30 {splitCellBg(srow.right?.kind ?? '', 'after', srow.right?.diffLineIndex ?? -1, srow.right?.line ?? null)} {srow.right?.line != null ? 'cursor-pointer hover:bg-interactive-accent/10' : ''}"
										onclick={(e) => {
											if (!srow.right || srow.right.line == null) return;
											e.stopPropagation();
											const rowKind = srow.right.kind === 'add' ? 'add' as const : 'context' as const;
											openCtxMenu(e, 'after', srow.right.line, srow.hunkIndex ?? -1, srow.right.diffLineIndex, rowKind);
										}}
									>
										{srow.right?.line ?? ''}
									</td>
									<td
										class="w-1/2 pl-2 pr-1 whitespace-pre-wrap break-all
											{srow.right?.kind === 'add' && !readOnly ? 'cursor-pointer' : ''}
											{splitCellBg(srow.right?.kind ?? '', 'after', srow.right?.diffLineIndex ?? -1, srow.right?.line ?? null)}"
										tabindex={srow.right?.kind === 'add' && !readOnly ? 0 : -1}
										role={srow.right?.kind === 'add' && !readOnly ? 'button' : undefined}
										onclick={(e) => { if (srow.right?.kind === 'add') handleSplitCellClick(e, 'after', srow.right.diffLineIndex, 'add'); }}
										onkeydown={(e) => { if (srow.right?.kind === 'add') handleSplitCellKeyDown(e, 'after', srow.right!.diffLineIndex, 'add'); }}
									>
										{#if srow.right?.kind === 'add'}
											<span class="text-diff-add-fg select-text">+{srow.right.text}</span>
										{:else if srow.right?.kind === 'context'}
											<span class="text-foreground select-text">&nbsp;{srow.right.text}</span>
										{:else}
											&nbsp;
										{/if}
									</td>
								</tr>
								{@const lineComments = getSplitRowComments(srow)}
								{#if lineComments.length > 0}
									<tr>
										<td colspan={splitColCount} class="p-0">
											{#each lineComments as comment (comment.id)}
												<div class="px-4 py-2 bg-muted/20 border-l-2 border-interactive-accent">
													{#if editingCommentId === comment.id}
													<div class="space-y-2">
														<textarea
															value={editBody}
															oninput={(e) => { editBody = e.currentTarget.value; }}
															class="w-full text-xs p-2 bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
															rows="2"
														></textarea>
														<div class="flex gap-1.5 justify-end">
															<button onclick={() => { editingCommentId = null; }} class="px-2 py-0.5 text-[10px] rounded bg-muted text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
															<button onclick={() => { onEditComment?.(comment.id, { body: editBody }); editingCommentId = null; }} class="px-2 py-0.5 text-[10px] rounded bg-interactive-accent text-interactive-accent-foreground hover:brightness-110">Save</button>
														</div>
													</div>
													{:else}
													<div class="flex items-center gap-2 group/comment">
														<span class="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded {severityColor(comment.severity)}">{comment.severity}</span>
														<span class="flex-1 text-xs text-foreground whitespace-pre-wrap">{comment.body}</span>
														<div class="flex gap-1 opacity-0 group-hover/comment:opacity-100 transition-opacity">
															<button onclick={() => { editingCommentId = comment.id; editBody = comment.body; }} class="p-0.5 rounded hover:bg-muted" title="Edit">
																<Pencil class="w-3 h-3 text-muted-foreground" />
															</button>
															<button onclick={() => onRemoveComment?.(comment.id)} class="p-0.5 rounded hover:bg-muted" title="Remove">
																<Trash2 class="w-3 h-3 text-muted-foreground" />
															</button>
														</div>
													</div>
													{/if}
												</div>
											{/each}
										</td>
									</tr>
								{/if}
								{#if isComposerForCell('before', srow.left?.line ?? null) || isComposerForCell('after', srow.right?.line ?? null)}
									<tr bind:this={composerRowEl}>
										<td colspan={splitColCount} class="p-0">
											<div class="border border-interactive-accent/50 rounded m-1 bg-background shadow-sm p-3 space-y-2">
												<div class="flex gap-2">
													{#each (['note', 'warning', 'blocker'] as const) as sev}
														<label class="flex items-center gap-1 text-[11px] cursor-pointer">
															<input type="radio" checked={composerState?.severity === sev} onchange={() => onComposerSeverityChange?.(sev)} class="accent-interactive-accent" />
															{sev}
														</label>
													{/each}
												</div>
												<textarea
													value={composerState?.body ?? ''}
													oninput={(e) => onComposerBodyChange?.(e.currentTarget.value)}
													onkeydown={handleComposerKeydown}
													placeholder="Comment..."
													class="w-full text-xs p-2 bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
													rows="3"
												></textarea>
												<div class="flex gap-1.5 justify-end">
													<button onclick={() => onComposerClose?.()} class="px-2.5 py-1 text-[11px] rounded bg-muted text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
													<button
														onclick={() => onComposerSubmit?.()}
														disabled={!composerState?.body?.trim()}
														class="px-2.5 py-1 text-[11px] rounded transition-all {composerState?.body?.trim() ? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110' : 'bg-muted text-muted-foreground cursor-not-allowed'}"
													>Add comment</button>
												</div>
											</div>
										</td>
									</tr>
								{/if}
							{/if}
						{/each}
					</tbody>
				</table>
			{:else}
				<!-- Unified diff -->
				<table class="w-full border-collapse">
					<tbody>
						{#each rows as row, idx (idx)}
							{#if row.kind === 'hunk-header'}
								<tr class={rowBgClass(row)}>
									<td colspan={onStageLine ? 4 : 3} class="px-2 py-1 text-muted-foreground" style:font-size={`${headerFontSize}px`}>
										<div class="flex items-center gap-2">
											<span class="flex-1 truncate">{row.beforeText}</span>
											{#if !readOnly}
												{#if activeTab === 'unstaged'}
													<button
														onclick={() => onStageHunk(row.hunkIndex!)}
														class="px-1.5 py-0.5 text-[10px] rounded bg-git-added/20 text-git-added hover:bg-git-added/30 transition-colors"
														title="Stage hunk"
													>
														<Plus class="w-3 h-3 inline" /> Stage
													</button>
												{:else}
													<button
														onclick={() => onUnstageHunk(row.hunkIndex!)}
														class="px-1.5 py-0.5 text-[10px] rounded bg-git-deleted/20 text-git-deleted hover:bg-git-deleted/30 transition-colors"
														title="Unstage hunk"
													>
														<Minus class="w-3 h-3 inline" /> Unstage
													</button>
												{/if}
											{/if}
										</div>
									</td>
								</tr>
							{:else}
								<tr
									class="select-none {rowBgClass(row)} {row.kind === 'add' || row.kind === 'del' ? !readOnly ? 'cursor-pointer hover:brightness-95' : '' : ''}"
									tabindex={row.kind === 'add' || row.kind === 'del' ? !readOnly ? 0 : -1 : -1}
									role={row.kind === 'add' || row.kind === 'del' ? !readOnly ? 'button' : undefined : undefined}
									onclick={(e) => handleLineClick(e, row)}
									onkeydown={(e) => handleLineKeyDown(e, row)}
									oncontextmenu={(e) => handleUnifiedCtxMenu(e, row)}
								>
									<!-- Gutter: stage/unstage button -->
									{#if onStageLine}
										<td class="w-8 select-none border-r border-border/30 p-0">
											<div class="flex items-center justify-center leading-5">
												{#if row.kind === 'add' || row.kind === 'del'}
													{#if activeTab === 'unstaged'}
														<button
															onclick={(e) => { e.stopPropagation(); onStageLine(row.diffLineIndex); }}
															class="flex items-center justify-center text-muted-foreground/30 hover:text-git-added hover:bg-git-added/20 transition-colors rounded p-0.5"
															title="Stage line"
														>
															<Plus class="w-3 h-3" />
														</button>
													{:else}
														<button
															onclick={(e) => { e.stopPropagation(); onUnstageLine?.(row.diffLineIndex); }}
															class="flex items-center justify-center text-muted-foreground/30 hover:text-git-deleted hover:bg-git-deleted/20 transition-colors rounded p-0.5"
															title="Unstage line"
														>
															<Minus class="w-3 h-3" />
														</button>
													{/if}
												{/if}
											</div>
										</td>
									{/if}
									<!-- Before line number (tap to open context menu) -->
									<td
										class="w-12 text-right pr-2 select-none {lineNumClass(row)} border-r border-border/30 {row.beforeLine != null ? 'cursor-pointer hover:bg-interactive-accent/10' : ''}"
										onclick={(e) => {
											if (row.beforeLine == null) return;
											e.stopPropagation();
											const side: 'before' | 'after' = row.kind === 'del' ? 'before' : 'after';
											openCtxMenu(e, side, row.kind === 'del' ? row.beforeLine : (row.afterLine ?? row.beforeLine), row.hunkIndex, row.diffLineIndex, row.kind as 'add' | 'del' | 'context');
										}}
									>
										{row.beforeLine ?? ''}
									</td>
									<!-- After line number (tap to open context menu) -->
									<td
										class="w-12 text-right pr-2 select-none {lineNumClass(row)} border-r border-border/30 {row.afterLine != null ? 'cursor-pointer hover:bg-interactive-accent/10' : ''}"
										onclick={(e) => {
											if (row.afterLine == null) return;
											e.stopPropagation();
											const side: 'before' | 'after' = row.kind === 'del' ? 'before' : 'after';
											openCtxMenu(e, side, row.kind === 'del' ? row.beforeLine : (row.afterLine ?? row.beforeLine), row.hunkIndex, row.diffLineIndex, row.kind as 'add' | 'del' | 'context');
										}}
									>
										{row.afterLine ?? ''}
									</td>
									<!-- Content -->
									<td class="pl-2 pr-3 whitespace-pre-wrap break-all">
										{#if row.kind === 'add'}
											<span class="text-diff-add-fg select-text">+{row.afterText}</span>
										{:else if row.kind === 'del'}
											<span class="text-diff-del-fg select-text">-{row.beforeText}</span>
										{:else}
											<span class="text-foreground select-text">&nbsp;{row.beforeText || row.afterText}</span>
										{/if}
									</td>
								</tr>
								{@const lineComments = getLineComments(row)}
								{#if lineComments.length > 0}
									<tr>
										<td colspan={unifiedColCount} class="p-0">
											{#each lineComments as comment (comment.id)}
												<div class="px-4 py-2 bg-muted/20 border-l-2 border-interactive-accent">
													{#if editingCommentId === comment.id}
													<div class="space-y-2">
														<textarea
															value={editBody}
															oninput={(e) => { editBody = e.currentTarget.value; }}
															class="w-full text-xs p-2 bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
															rows="2"
														></textarea>
														<div class="flex gap-1.5 justify-end">
															<button onclick={() => { editingCommentId = null; }} class="px-2 py-0.5 text-[10px] rounded bg-muted text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
															<button onclick={() => { onEditComment?.(comment.id, { body: editBody }); editingCommentId = null; }} class="px-2 py-0.5 text-[10px] rounded bg-interactive-accent text-interactive-accent-foreground hover:brightness-110">Save</button>
														</div>
													</div>
													{:else}
													<div class="flex items-center gap-2 group/comment">
														<span class="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded {severityColor(comment.severity)}">{comment.severity}</span>
														<span class="flex-1 text-xs text-foreground whitespace-pre-wrap">{comment.body}</span>
														<div class="flex gap-1 opacity-0 group-hover/comment:opacity-100 transition-opacity">
															<button onclick={() => { editingCommentId = comment.id; editBody = comment.body; }} class="p-0.5 rounded hover:bg-muted" title="Edit">
																<Pencil class="w-3 h-3 text-muted-foreground" />
															</button>
															<button onclick={() => onRemoveComment?.(comment.id)} class="p-0.5 rounded hover:bg-muted" title="Remove">
																<Trash2 class="w-3 h-3 text-muted-foreground" />
															</button>
														</div>
													</div>
													{/if}
												</div>
											{/each}
										</td>
									</tr>
								{/if}
								{#if isComposerForRow(row)}
									<tr bind:this={composerRowEl}>
										<td colspan={unifiedColCount} class="p-0">
											<div class="border border-interactive-accent/50 rounded m-1 bg-background shadow-sm p-3 space-y-2">
												<div class="flex gap-2">
													{#each (['note', 'warning', 'blocker'] as const) as sev}
														<label class="flex items-center gap-1 text-[11px] cursor-pointer">
															<input type="radio" checked={composerState?.severity === sev} onchange={() => onComposerSeverityChange?.(sev)} class="accent-interactive-accent" />
															{sev}
														</label>
													{/each}
												</div>
												<textarea
													value={composerState?.body ?? ''}
													oninput={(e) => onComposerBodyChange?.(e.currentTarget.value)}
													onkeydown={handleComposerKeydown}
													placeholder="Comment..."
													class="w-full text-xs p-2 bg-background border border-border rounded resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
													rows="3"
												></textarea>
												<div class="flex gap-1.5 justify-end">
													<button onclick={() => onComposerClose?.()} class="px-2.5 py-1 text-[11px] rounded bg-muted text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
													<button
														onclick={() => onComposerSubmit?.()}
														disabled={!composerState?.body?.trim()}
														class="px-2.5 py-1 text-[11px] rounded transition-all {composerState?.body?.trim() ? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110' : 'bg-muted text-muted-foreground cursor-not-allowed'}"
													>Add comment</button>
												</div>
											</div>
										</td>
									</tr>
								{/if}
							{/if}
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	{/if}

	<!-- Context menu for line-level actions (right-click / long-press) -->
	{#if ctxMenu.open}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="fixed inset-0 z-50"
			onclick={closeCtxMenu}
			oncontextmenu={(e) => { e.preventDefault(); closeCtxMenu(); }}
			onkeydown={(e) => { if (e.key === 'Escape') closeCtxMenu(); }}
		>
			<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
			<div
				class="fixed z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[160px] text-xs"
				style="left:{ctxMenu.x}px; top:{ctxMenu.y}px;"
				onclick={(e) => e.stopPropagation()}
			>
				{#if ctxMenu.line != null}
					<button
						onclick={() => { onAddComment(ctxMenu.side, ctxMenu.line!); closeCtxMenu(); }}
						class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors"
					>
						Add comment
					</button>
					{#if onOpenInEditor}
						<button
							onclick={() => { onOpenInEditor(ctxMenu.line!); closeCtxMenu(); }}
							class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors"
						>
							Open in Editor
						</button>
					{/if}
				{/if}
				{#if !readOnly && ctxMenu.hunkIndex >= 0}
					{#if activeTab === 'unstaged'}
						<button
							onclick={() => { onStageHunk(ctxMenu.hunkIndex); closeCtxMenu(); }}
							class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors text-git-added"
						>
							Stage hunk
						</button>
					{:else}
						<button
							onclick={() => { onUnstageHunk(ctxMenu.hunkIndex); closeCtxMenu(); }}
							class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors text-git-deleted"
						>
							Unstage hunk
						</button>
					{/if}
				{/if}
				{#if !readOnly && onStageLine && (ctxMenu.rowKind === 'add' || ctxMenu.rowKind === 'del')}
					{#if activeTab === 'unstaged'}
						<button
							onclick={() => { onStageLine!(ctxMenu.diffLineIndex); closeCtxMenu(); }}
							class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors text-git-added"
						>
							Stage line
						</button>
					{:else}
						<button
							onclick={() => { onUnstageLine?.(ctxMenu.diffLineIndex); closeCtxMenu(); }}
							class="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors text-git-deleted"
						>
							Unstage line
						</button>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>
