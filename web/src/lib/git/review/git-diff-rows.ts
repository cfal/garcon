import type { GitDiffTab } from '$lib/api/git.js';
import type { CodeHighlightSegment } from '$lib/highlighting/code-highlight-types.js';
import type { GitRenderedDiffRow } from './git-rendered-diff-types.js';
import type { GitDiffFileSyntaxResult } from './git-diff-syntax.js';
import type { GitDiffSeverity, GitDiffSide } from '$lib/git/review/git-inline-comment.svelte.js';
import { makeLineSelectionKey } from '$lib/git/review/git-line-selection.svelte.js';

export type { GitDiffSeverity, GitDiffSide } from '$lib/git/review/git-inline-comment.svelte.js';
export type GitDiffContentKind = 'context' | 'add' | 'del';
export type GitDiffRowKind = GitDiffContentKind | 'hunk-header';

export interface RenderedDiffRow {
	key: string;
	kind: GitDiffRowKind;
	beforeLine: number | null;
	afterLine: number | null;
	beforeText: string;
	afterText: string;
	hunkId?: string;
	hunkIndex: number;
	diffLineIndex: number;
}

export interface SplitDiffCell {
	kind: 'context' | 'del' | 'add' | 'empty';
	line: number | null;
	text: string;
	diffLineIndex: number;
}

export interface SplitDiffRow {
	key: string;
	isHeader: boolean;
	headerText?: string;
	hunkIndex?: number;
	left: SplitDiffCell | null;
	right: SplitDiffCell | null;
}

export interface GitDiffComposerDraft {
	open: boolean;
	filePath: string;
	side: GitDiffSide;
	line: number;
	body: string;
	severity: GitDiffSeverity;
}

export type GitDiffComposerTarget = Pick<
	GitDiffComposerDraft,
	'open' | 'filePath' | 'side' | 'line'
>;

export interface GitDiffLineContextTarget {
	side: GitDiffSide;
	line: number;
	hunkIndex: number;
	diffLineIndex: number;
	rowKind: GitDiffContentKind;
}

export interface UnifiedDiffRowView {
	key: string;
	row: RenderedDiffRow;
	isHunkHeader: boolean;
	isSelectable: boolean;
	selectionKey: string | null;
	bgClass: string;
	lineNumClass: string;
	textClass: string;
	textPrefix: string;
	text: string;
	segments?: readonly CodeHighlightSegment[];
	showComposer: boolean;
	beforeContextTarget: GitDiffLineContextTarget | null;
	afterContextTarget: GitDiffLineContextTarget | null;
	rowContextTarget: GitDiffLineContextTarget | null;
}

export interface SplitDiffCellView {
	side: GitDiffSide;
	cell: SplitDiffCell;
	isSelectable: boolean;
	selectionKey: string | null;
	bgClass: string;
	lineNumClass: string;
	textClass: string;
	textPrefix: string;
	segments?: readonly CodeHighlightSegment[];
	contextTarget: GitDiffLineContextTarget | null;
}

export interface SplitDiffRowView {
	key: string;
	row: SplitDiffRow;
	isHunkHeader: boolean;
	showComposer: boolean;
	left: SplitDiffCellView | null;
	right: SplitDiffCellView | null;
}

interface DiffRowViewOptions {
	filePath: string;
	activeTab: GitDiffTab;
	readOnly: boolean;
	selectedLineKeys: Set<string>;
	composerTarget: GitDiffComposerTarget | null;
	syntaxResult?: GitDiffFileSyntaxResult;
}

export function renderUnifiedDiffRow(row: GitRenderedDiffRow): RenderedDiffRow {
	if (row.kind === 'hunk') {
		return {
			key: row.key,
			kind: 'hunk-header',
			beforeLine: null,
			afterLine: null,
			beforeText: row.text,
			afterText: '',
			hunkId: row.hunkId,
			hunkIndex: row.hunkIndex,
			diffLineIndex: -1,
		};
	}
	return {
		key: row.key,
		kind: row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'context',
		beforeLine: row.beforeLine,
		afterLine: row.afterLine,
		beforeText: row.kind === 'add' ? '' : row.text,
		afterText: row.kind === 'del' ? '' : row.text,
		hunkId: row.hunkId,
		hunkIndex: row.hunkIndex,
		diffLineIndex: row.diffLineIndex,
	};
}

export function buildUnifiedDiffRowView(
	options: DiffRowViewOptions,
	row: RenderedDiffRow,
): UnifiedDiffRowView {
	const selectionKey = getUnifiedSelectionKey(row, options.filePath, options.activeTab);
	const isSelectable = !options.readOnly && selectionKey !== null;
	const isSelected = isSelectable && options.selectedLineKeys.has(selectionKey);
	const showComposer = isComposerForUnifiedRow(row, options.composerTarget);
	const segments = unifiedSyntaxSegments(row, options.syntaxResult);

	return {
		key: row.key,
		row,
		isHunkHeader: row.kind === 'hunk-header',
		isSelectable,
		selectionKey,
		bgClass: rowBgClass(row.kind, isSelected, showComposer),
		lineNumClass: lineNumClass(row.kind),
		textClass: textClass(row.kind),
		textPrefix: textPrefix(row.kind),
		text: unifiedText(row),
		...(segments ? { segments } : {}),
		showComposer,
		beforeContextTarget: getUnifiedContextTarget(row, 'before'),
		afterContextTarget: getUnifiedContextTarget(row, 'after'),
		rowContextTarget: getUnifiedContextTarget(row, row.kind === 'del' ? 'before' : 'after'),
	};
}

export function buildSplitDiffRowView(
	options: DiffRowViewOptions,
	row: SplitDiffRow,
): SplitDiffRowView {
	return {
		key: row.key,
		row,
		isHunkHeader: row.isHeader,
		showComposer: isComposerForSplitRow(row, options.composerTarget),
		left: row.left ? buildSplitCellView(row.left, 'before', row.hunkIndex ?? -1, options) : null,
		right: row.right ? buildSplitCellView(row.right, 'after', row.hunkIndex ?? -1, options) : null,
	};
}

function buildSplitCellView(
	cell: SplitDiffCell,
	side: GitDiffSide,
	hunkIndex: number,
	options: DiffRowViewOptions,
): SplitDiffCellView {
	const selectionKey = getSplitCellSelectionKey(cell, side, options.filePath, options.activeTab);
	const isSelectable = !options.readOnly && selectionKey !== null;
	const isSelected = isSelectable && options.selectedLineKeys.has(selectionKey);
	const isComposerTarget =
		cell.line !== null && isComposerForCell(side, cell.line, options.composerTarget);
	const segments = splitSyntaxSegments(cell, side, options.syntaxResult);

	return {
		side,
		cell,
		isSelectable,
		selectionKey,
		bgClass: splitCellBgClass(cell.kind, isSelected, isComposerTarget),
		lineNumClass: lineNumClass(cell.kind),
		textClass: textClass(cell.kind),
		textPrefix: textPrefix(cell.kind),
		...(segments ? { segments } : {}),
		contextTarget: getSplitContextTarget(cell, side, hunkIndex),
	};
}

function unifiedSyntaxSegments(
	row: RenderedDiffRow,
	result: GitDiffFileSyntaxResult | undefined,
): readonly CodeHighlightSegment[] | undefined {
	if (row.kind === 'hunk-header') return undefined;
	const side = row.kind === 'del' ? result?.before : result?.after;
	return side?.lines.get(row.diffLineIndex);
}

function splitSyntaxSegments(
	cell: SplitDiffCell,
	side: GitDiffSide,
	result: GitDiffFileSyntaxResult | undefined,
): readonly CodeHighlightSegment[] | undefined {
	if (cell.kind === 'empty') return undefined;
	return (side === 'before' ? result?.before : result?.after)?.lines.get(cell.diffLineIndex);
}

function getUnifiedSelectionKey(
	row: RenderedDiffRow,
	filePath: string,
	activeTab: GitDiffTab,
): string | null {
	if (row.kind !== 'add' && row.kind !== 'del') return null;
	return makeLineSelectionKey(
		filePath,
		activeTab,
		row.kind === 'del' ? 'before' : 'after',
		row.diffLineIndex,
	);
}

export function getRenderedSelectionKey(
	row: RenderedDiffRow,
	filePath: string,
	activeTab: GitDiffTab,
): string | null {
	return getUnifiedSelectionKey(row, filePath, activeTab);
}

function getSplitCellSelectionKey(
	cell: SplitDiffCell,
	side: GitDiffSide,
	filePath: string,
	activeTab: GitDiffTab,
): string | null {
	if (cell.kind !== 'add' && cell.kind !== 'del') return null;
	return makeLineSelectionKey(filePath, activeTab, side, cell.diffLineIndex);
}

function getUnifiedContextTarget(
	row: RenderedDiffRow,
	side: GitDiffSide,
): GitDiffLineContextTarget | null {
	if (row.kind === 'hunk-header') return null;
	const line = side === 'before' ? row.beforeLine : row.afterLine;
	if (line === null) return null;

	return {
		side,
		line,
		hunkIndex: row.hunkIndex,
		diffLineIndex: row.diffLineIndex,
		rowKind: row.kind,
	};
}

function getSplitContextTarget(
	cell: SplitDiffCell,
	side: GitDiffSide,
	hunkIndex: number,
): GitDiffLineContextTarget | null {
	if (cell.kind === 'empty' || cell.line === null) return null;
	return {
		side,
		line: cell.line,
		hunkIndex,
		diffLineIndex: cell.diffLineIndex,
		rowKind: cell.kind === 'add' || cell.kind === 'del' ? cell.kind : 'context',
	};
}

function isComposerForUnifiedRow(
	row: RenderedDiffRow,
	composerTarget: GitDiffComposerTarget | null,
): boolean {
	if (row.kind === 'del') return isComposerForCell('before', row.beforeLine, composerTarget);
	if (row.kind === 'add') return isComposerForCell('after', row.afterLine, composerTarget);
	if (row.kind === 'context') {
		return (
			isComposerForCell('before', row.beforeLine, composerTarget) ||
			isComposerForCell('after', row.afterLine, composerTarget)
		);
	}
	return false;
}

function isComposerForSplitRow(
	row: SplitDiffRow,
	composerTarget: GitDiffComposerTarget | null,
): boolean {
	return (
		isComposerForCell('before', row.left?.line ?? null, composerTarget) ||
		isComposerForCell('after', row.right?.line ?? null, composerTarget)
	);
}

function isComposerForCell(
	side: GitDiffSide,
	line: number | null,
	composerTarget: GitDiffComposerTarget | null,
): boolean {
	if (!composerTarget?.open || line === null) return false;
	return composerTarget.side === side && composerTarget.line === line;
}

function rowBgClass(kind: GitDiffRowKind, isSelected: boolean, isComposerTarget: boolean): string {
	if (isSelected) return 'bg-interactive-accent/20';
	if (isComposerTarget) return 'bg-interactive-accent/10';
	switch (kind) {
		case 'add':
			return 'bg-diff-add';
		case 'del':
			return 'bg-diff-del';
		case 'hunk-header':
			return 'bg-diff-hunk-header';
		default:
			return '';
	}
}

function splitCellBgClass(
	kind: SplitDiffCell['kind'],
	isSelected: boolean,
	isComposerTarget: boolean,
): string {
	if (isSelected) return 'bg-interactive-accent/20';
	if (isComposerTarget) return 'bg-interactive-accent/10';
	switch (kind) {
		case 'add':
			return 'bg-diff-add';
		case 'del':
			return 'bg-diff-del';
		default:
			return '';
	}
}

function lineNumClass(kind: GitDiffRowKind | 'empty'): string {
	switch (kind) {
		case 'add':
			return 'text-diff-add-line-num';
		case 'del':
			return 'text-diff-del-line-num';
		default:
			return 'text-foreground/70';
	}
}

function textClass(kind: GitDiffRowKind | 'empty'): string {
	if (kind === 'add') return 'text-diff-add-fg';
	if (kind === 'del') return 'text-diff-del-fg';
	return 'text-foreground';
}

function textPrefix(kind: GitDiffRowKind | 'empty'): string {
	if (kind === 'add') return '+';
	if (kind === 'del') return '-';
	return '\u00a0';
}

function unifiedText(row: RenderedDiffRow): string {
	if (row.kind === 'add') return row.afterText;
	if (row.kind === 'del') return row.beforeText;
	return row.beforeText || row.afterText;
}
