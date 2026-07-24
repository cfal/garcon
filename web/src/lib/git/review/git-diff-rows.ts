import type { GitDiffTab } from '$lib/api/git.js';
import type { GitRenderedDiffRow } from './git-rendered-diff-types.js';
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

interface BuildUnifiedRowViewsOptions {
	rows: RenderedDiffRow[];
	filePath: string;
	activeTab: GitDiffTab;
	readOnly: boolean;
	selectedLineKeys: Set<string>;
	composerTarget: GitDiffComposerTarget | null;
}

interface BuildSplitRowViewsOptions {
	rows: SplitDiffRow[];
	filePath: string;
	activeTab: GitDiffTab;
	readOnly: boolean;
	selectedLineKeys: Set<string>;
	composerTarget: GitDiffComposerTarget | null;
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

export function buildSplitDiffRows(rows: RenderedDiffRow[]): SplitDiffRow[] {
	const result: SplitDiffRow[] = [];
	let rowIndex = 0;
	let currentHunkIndex = 0;
	let pairedRowIndex = 0;

	while (rowIndex < rows.length) {
		const row = rows[rowIndex];

		if (row.kind === 'hunk-header') {
			currentHunkIndex = row.hunkIndex;
			result.push({
				key: `split:${row.key}`,
				isHeader: true,
				headerText: row.beforeText,
				hunkIndex: row.hunkIndex,
				left: null,
				right: null,
			});
			rowIndex++;
			continue;
		}

		if (row.kind === 'context') {
			result.push({
				key: `split:${row.key}`,
				isHeader: false,
				hunkIndex: currentHunkIndex,
				left: {
					kind: 'context',
					line: row.beforeLine,
					text: row.beforeText,
					diffLineIndex: row.diffLineIndex,
				},
				right: {
					kind: 'context',
					line: row.afterLine,
					text: row.afterText || row.beforeText,
					diffLineIndex: row.diffLineIndex,
				},
			});
			rowIndex++;
			continue;
		}

		const deletions: RenderedDiffRow[] = [];
		const additions: RenderedDiffRow[] = [];

		while (rowIndex < rows.length && rows[rowIndex].kind === 'del') {
			deletions.push(rows[rowIndex]);
			rowIndex++;
		}
		while (rowIndex < rows.length && rows[rowIndex].kind === 'add') {
			additions.push(rows[rowIndex]);
			rowIndex++;
		}

		const maxLength = Math.max(deletions.length, additions.length);
		for (let pairIndex = 0; pairIndex < maxLength; pairIndex++) {
			const deletion = deletions[pairIndex];
			const addition = additions[pairIndex];
			result.push({
				key: `split:pair:${pairedRowIndex++}:${deletion?.key ?? 'empty'}:${addition?.key ?? 'empty'}`,
				isHeader: false,
				hunkIndex: currentHunkIndex,
				left: deletion
					? {
							kind: 'del',
							line: deletion.beforeLine,
							text: deletion.beforeText,
							diffLineIndex: deletion.diffLineIndex,
						}
					: { kind: 'empty', line: null, text: '', diffLineIndex: -1 },
				right: addition
					? {
							kind: 'add',
							line: addition.afterLine,
							text: addition.afterText,
							diffLineIndex: addition.diffLineIndex,
						}
					: { kind: 'empty', line: null, text: '', diffLineIndex: -1 },
			});
		}
	}

	return result;
}

export function getSelectableLineKeys(
	rows: RenderedDiffRow[],
	filePath: string,
	activeTab: GitDiffTab,
): string[] {
	return rows
		.map((row) => getUnifiedSelectionKey(row, filePath, activeTab))
		.filter((key): key is string => key !== null);
}

export function buildUnifiedDiffRowViews(
	options: BuildUnifiedRowViewsOptions,
): UnifiedDiffRowView[] {
	return options.rows.map((row) => buildUnifiedDiffRowView(options, row));
}

export function buildUnifiedDiffRowView(
	options: Omit<BuildUnifiedRowViewsOptions, 'rows'>,
	row: RenderedDiffRow,
): UnifiedDiffRowView {
		const selectionKey = getUnifiedSelectionKey(row, options.filePath, options.activeTab);
		const isSelectable = !options.readOnly && selectionKey !== null;
		const isSelected = isSelectable && options.selectedLineKeys.has(selectionKey);
		const showComposer = isComposerForUnifiedRow(row, options.composerTarget);

		return {
			key: row.key,
			row,
			isHunkHeader: row.kind === 'hunk-header',
			isSelectable,
			selectionKey,
			bgClass: rowBgClass(row.kind, isSelected, showComposer),
			lineNumClass: lineNumClass(row.kind),
			textClass: unifiedTextClass(row.kind),
			textPrefix: unifiedTextPrefix(row.kind),
			text: unifiedText(row),
			showComposer,
			beforeContextTarget: getUnifiedContextTarget(row, 'before'),
			afterContextTarget: getUnifiedContextTarget(row, 'after'),
			rowContextTarget: getUnifiedContextTarget(row, row.kind === 'del' ? 'before' : 'after'),
		};
}

export function buildSplitDiffRowViews(options: BuildSplitRowViewsOptions): SplitDiffRowView[] {
	return options.rows.map((row) => buildSplitDiffRowView(options, row));
}

export function buildSplitDiffRowView(
	options: Omit<BuildSplitRowViewsOptions, 'rows'>,
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
	options: Omit<BuildSplitRowViewsOptions, 'rows'>,
): SplitDiffCellView {
	const selectionKey = getSplitCellSelectionKey(cell, side, options.filePath, options.activeTab);
	const isSelectable = !options.readOnly && selectionKey !== null;
	const isSelected = isSelectable && options.selectedLineKeys.has(selectionKey);
	const isComposerTarget =
		cell.line !== null && isComposerForCell(side, cell.line, options.composerTarget);

	return {
		side,
		cell,
		isSelectable,
		selectionKey,
		bgClass: splitCellBgClass(cell.kind, isSelected, isComposerTarget),
		lineNumClass: splitLineNumClass(cell.kind),
		textClass: splitTextClass(cell.kind),
		textPrefix: splitTextPrefix(cell.kind),
		contextTarget: getSplitContextTarget(cell, side, hunkIndex),
	};
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

function lineNumClass(kind: GitDiffRowKind): string {
	switch (kind) {
		case 'add':
			return 'text-diff-add-line-num';
		case 'del':
			return 'text-diff-del-line-num';
		default:
			return 'text-muted-foreground/50';
	}
}

function splitLineNumClass(kind: SplitDiffCell['kind']): string {
	switch (kind) {
		case 'add':
			return 'text-diff-add-line-num';
		case 'del':
			return 'text-diff-del-line-num';
		default:
			return 'text-muted-foreground/50';
	}
}

function unifiedTextClass(kind: GitDiffRowKind): string {
	if (kind === 'add') return 'text-diff-add-fg';
	if (kind === 'del') return 'text-diff-del-fg';
	return 'text-foreground';
}

function splitTextClass(kind: SplitDiffCell['kind']): string {
	if (kind === 'add') return 'text-diff-add-fg';
	if (kind === 'del') return 'text-diff-del-fg';
	return 'text-foreground';
}

function unifiedTextPrefix(kind: GitDiffRowKind): string {
	if (kind === 'add') return '+';
	if (kind === 'del') return '-';
	return '\u00a0';
}

function splitTextPrefix(kind: SplitDiffCell['kind']): string {
	if (kind === 'add') return '+';
	if (kind === 'del') return '-';
	return '\u00a0';
}

function unifiedText(row: RenderedDiffRow): string {
	if (row.kind === 'add') return row.afterText;
	if (row.kind === 'del') return row.beforeText;
	return row.beforeText || row.afterText;
}
