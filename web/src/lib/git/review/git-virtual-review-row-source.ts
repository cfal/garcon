import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import type { GitRenderedDiffRow } from './git-rendered-diff-types.js';
import {
	buildSplitDiffRowView,
	buildUnifiedDiffRowView,
	getRenderedSelectionKey,
	renderUnifiedDiffRow,
	type RenderedDiffRow,
	type SplitDiffCell,
	type SplitDiffRow,
} from './git-diff-rows.js';
import { getGitSplitPatchIndex, type GitSplitPatchIndex } from './git-patch-index.js';
import type {
	BuildVirtualRowsOptions,
	GitVirtualReviewRow,
	GitVirtualFileLimitRow,
} from './git-virtual-review-document.svelte.js';
import type { GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';
import * as m from '$lib/paraglide/messages.js';

const DEFAULT_ROW_HEIGHT = 22;

type SegmentKind = 'header' | 'placeholder' | 'limit' | 'unified' | 'split' | 'collection';

interface RowSegment {
	start: number;
	count: number;
	kind: SegmentKind;
	file?: GitReviewFileSummary;
	body?: GitReviewFileBody;
	limitRow?: GitVirtualFileLimitRow;
	splitIndex?: GitSplitPatchIndex;
}

export interface GitVirtualReviewRowSource {
	readonly rowCount: number;
	rowAt(index: number): GitVirtualReviewRow | null;
	rowKey(index: number): string | number;
	estimateRowHeight(index: number, lineHeight: number): number;
	fileStart(filePath: string): number | undefined;
	fileState(filePath: string): 'pending' | 'resolved' | 'terminal';
	rowsInRange(start: number, end: number): GitVirtualReviewRow[];
}

export function buildGitVirtualReviewRowSource(
	options: BuildVirtualRowsOptions,
): GitVirtualReviewRowSource {
	return new IndexedGitVirtualReviewRowSource(options);
}

export function emptyGitVirtualReviewRowSource(): GitVirtualReviewRowSource {
	return {
		rowCount: 0,
		rowAt: () => null,
		rowKey: (index) => index,
		estimateRowHeight: (_index, lineHeight) => lineHeight,
		fileStart: () => undefined,
		fileState: () => 'terminal',
		rowsInRange: () => [],
	};
}

export function arrayGitVirtualReviewRowSource(
	rows: GitVirtualReviewRow[],
	fileRowIndex?: ReadonlyMap<string, number>,
): GitVirtualReviewRowSource {
	const starts =
		fileRowIndex ??
		new Map(
			rows.flatMap((row, index) =>
				row.kind === 'file-header' ? ([[row.filePath, index]] as const) : [],
			),
		);
	return {
		rowCount: rows.length,
		rowAt: (index) => rows[index] ?? null,
		rowKey: (index) => rows[index]?.id ?? index,
		estimateRowHeight: (index, lineHeight) => {
			const row = rows[index];
			if (!row) return lineHeight;
			return row.kind === 'unified-row' || row.kind === 'split-row'
				? Math.max(row.estimatedHeight, lineHeight)
				: row.estimatedHeight;
		},
		fileStart: (filePath) => starts.get(filePath),
		fileState: (filePath) => {
			const fileRows = rows.filter((row) => row.filePath === filePath);
			if (fileRows.some((row) => row.kind === 'file-placeholder')) return 'pending';
			if (fileRows.some((row) => row.kind === 'unified-row' || row.kind === 'split-row')) {
				return 'resolved';
			}
			return 'terminal';
		},
		rowsInRange: (start, end) => rows.slice(start, end),
	};
}

class IndexedGitVirtualReviewRowSource implements GitVirtualReviewRowSource {
	readonly rowCount: number;
	private readonly segments: RowSegment[] = [];
	private readonly fileStarts = new Map<string, number>();
	private readonly fileKeyBases = new Map<string, number>();
	private readonly fileStates = new Map<string, 'pending' | 'resolved' | 'terminal'>();
	private readonly selectableKeys = new Map<string, string[]>();

	constructor(private readonly options: BuildVirtualRowsOptions) {
		const summaryByPath = new Map(options.summary.files.map((file) => [file.path, file]));
		const orderedFiles =
			options.visibleFilePaths.length > 0
				? options.visibleFilePaths
						.map((filePath) => summaryByPath.get(filePath))
						.filter((file): file is GitReviewFileSummary => Boolean(file))
				: options.summary.files;
		let start = 0;
		for (let fileIndex = 0; fileIndex < orderedFiles.length; fileIndex += 1) {
			const file = orderedFiles[fileIndex];
			this.fileStarts.set(file.path, start);
			this.fileKeyBases.set(file.path, (fileIndex + 1) * 1_000_000);
			this.segments.push({ start, count: 1, kind: 'header', file });
			start += 1;
			if (options.collapsedFilePaths?.has(file.path)) {
				this.fileStates.set(file.path, 'terminal');
				continue;
			}
			const body = options.fileBodies[file.path];
			if (!body && options.placeholderLimit) {
				const limit = options.placeholderLimit;
				this.segments.push({
					start,
					count: 1,
					kind: 'limit',
					file,
					limitRow: fileLimitRow(options, file, limit.reason, limit.title, limit.message),
				});
				this.fileStates.set(file.path, 'terminal');
				start += 1;
				continue;
			}
			const terminal = terminalRow(options, file, body);
			if (terminal) {
				this.segments.push({ start, count: 1, kind: 'limit', file, body, limitRow: terminal });
				this.fileStates.set(file.path, 'terminal');
				start += 1;
				continue;
			}
			if (!body) {
				this.segments.push({ start, count: 1, kind: 'placeholder', file });
				this.fileStates.set(file.path, 'pending');
				start += 1;
				continue;
			}
			if (body.patch === null) {
				this.segments.push({
					start,
					count: 1,
					kind: 'limit',
					file,
					limitRow: fileLimitRow(
						options,
						file,
						'git-timeout',
						m.git_virtual_diff_failed(),
						m.git_virtual_diff_failed_message(),
					),
				});
				this.fileStates.set(file.path, 'terminal');
				start += 1;
				continue;
			}
			if (options.diffMode === 'split') {
				const index = body.patchIndex!;
				const splitIndex = getGitSplitPatchIndex(index);
				const count = splitIndex.rowCount;
				this.segments.push({ start, count, kind: 'split', file, body, splitIndex });
				start += count;
			} else {
				const count = body.renderedRowCount;
				this.segments.push({ start, count, kind: 'unified', file, body });
				start += count;
			}
			this.fileStates.set(file.path, 'resolved');
		}
		if (options.summary.collectionLimit) {
			this.segments.push({ start, count: 1, kind: 'collection' });
			start += 1;
		}
		this.rowCount = start;
	}

	rowAt(index: number): GitVirtualReviewRow | null {
		if (index < 0 || index >= this.rowCount) return null;
		const segment = this.segmentAt(index);
		if (!segment) return null;
		const localIndex = index - segment.start;
		switch (segment.kind) {
			case 'header':
				return this.headerRow(segment.file!);
			case 'placeholder':
				return this.placeholderRow(segment.file!);
			case 'limit':
				return segment.limitRow ?? null;
			case 'collection':
				return this.collectionRow();
			case 'unified':
				return this.unifiedRow(segment.file!, segment.body!, localIndex);
			case 'split':
				return this.splitRow(segment, localIndex);
		}
	}

	rowKey(index: number): string | number {
		const segment = this.segmentAt(index);
		if (!segment) return index;
		if (segment.kind === 'collection') return Number.MAX_SAFE_INTEGER;
		const base = this.fileKeyBases.get(segment.file?.path ?? '') ?? 0;
		if (segment.kind === 'header') return base;
		if (segment.kind === 'unified' || segment.kind === 'split') {
			const modeOffset = segment.kind === 'split' ? 100_000 : 100;
			return base + modeOffset + index - segment.start;
		}
		return base + 1;
	}

	estimateRowHeight(index: number, lineHeight: number): number {
		const segment = this.segmentAt(index);
		if (!segment) return lineHeight;
		if (segment.kind === 'header') return 42;
		if (segment.kind === 'placeholder') {
			return Math.max(
				96,
				Math.min(720, (segment.file?.estimatedRows ?? 1) * DEFAULT_ROW_HEIGHT),
			);
		}
		if (segment.kind === 'limit' || segment.kind === 'collection') return 112;
		const localIndex = index - segment.start;
		const isHunk =
			segment.kind === 'unified'
				? segment.body!.patchIndex!.rowKindAt(localIndex) === 'hunk'
				: splitEntryIsHunk(segment.body!, segment.splitIndex!, localIndex);
		return isHunk ? Math.max(28, lineHeight + 8) : lineHeight;
	}

	fileStart(filePath: string): number | undefined {
		return this.fileStarts.get(filePath);
	}

	fileState(filePath: string): 'pending' | 'resolved' | 'terminal' {
		return this.fileStates.get(filePath) ?? 'terminal';
	}

	rowsInRange(start: number, end: number): GitVirtualReviewRow[] {
		const rows: GitVirtualReviewRow[] = [];
		const safeStart = Math.max(0, start);
		const safeEnd = Math.min(this.rowCount, end);
		for (let index = safeStart; index < safeEnd; index += 1) {
			const row = this.rowAt(index);
			if (row) rows.push(row);
		}
		return rows;
	}

	private segmentAt(index: number): RowSegment | null {
		let low = 0;
		let high = this.segments.length - 1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			const segment = this.segments[middle];
			if (index < segment.start) high = middle - 1;
			else if (index >= segment.start + segment.count) low = middle + 1;
			else return segment;
		}
		return null;
	}

	private headerRow(file: GitReviewFileSummary): GitVirtualReviewRow {
		return {
			kind: 'file-header',
			id: `${this.options.summary.documentId}:file:${encodeURIComponent(file.path)}:header`,
			filePath: file.path,
			estimatedHeight: 42,
			file,
			isFocused: this.options.focusedFilePath === file.path,
		};
	}

	private placeholderRow(file: GitReviewFileSummary): GitVirtualReviewRow {
		return {
			kind: 'file-placeholder',
			id: `${this.options.summary.documentId}:file:${encodeURIComponent(file.path)}:placeholder`,
			filePath: file.path,
			estimatedHeight: Math.max(96, Math.min(720, file.estimatedRows * DEFAULT_ROW_HEIGHT)),
			file,
			loadState: this.options.loadingBodies.has(file.path) ? 'loading' : 'unloaded',
		};
	}

	private collectionRow(): GitVirtualReviewRow {
		return {
			kind: 'collection-limit',
			id: `${this.options.summary.documentId}:collection-limit`,
			filePath: '',
			estimatedHeight: 112,
			title: m.git_virtual_diff_limit_reached(),
			message: this.options.summary.collectionLimit?.message ?? '',
		};
	}

	private unifiedRow(
		file: GitReviewFileSummary,
		body: GitReviewFileBody,
		localIndex: number,
	): GitVirtualReviewRow {
		const row = renderUnifiedDiffRow(renderedRowAt(body, localIndex));
		const interaction = interactionForFile(this.options, file);
		const view = buildUnifiedDiffRowView(interaction.viewOptions, row);
		return {
			kind: 'unified-row',
			id: diffRowId(this.options, file.path, view.key, 'unified'),
			filePath: file.path,
			estimatedHeight: estimateViewHeight(view.isHunkHeader, view.showComposer),
			file,
			view,
			actionTarget: interaction.actionTarget,
			selectableLineKeys: () => this.selectableLineKeys(file, body, interaction.activeTab),
		};
	}

	private splitRow(segment: RowSegment, localIndex: number): GitVirtualReviewRow {
		const file = segment.file!;
		const body = segment.body!;
		const row = indexedSplitRow(body, segment.splitIndex!, localIndex);
		const interaction = interactionForFile(this.options, file);
		const view = buildSplitDiffRowView(interaction.splitViewOptions, row);
		return {
			kind: 'split-row',
			id: diffRowId(this.options, file.path, view.key, 'split'),
			filePath: file.path,
			estimatedHeight: estimateViewHeight(view.isHunkHeader, view.showComposer),
			file,
			view,
			actionTarget: interaction.actionTarget,
			selectableLineKeys: () => this.selectableLineKeys(file, body, interaction.activeTab),
		};
	}

	private selectableLineKeys(
		file: GitReviewFileSummary,
		body: GitReviewFileBody,
		activeTab: 'staged' | 'unstaged',
	): string[] {
		if (this.options.interaction.kind !== 'workbench') return [];
		const cached = this.selectableKeys.get(file.path);
		if (cached) return cached;
		const keys: string[] = [];
		const count = body.patchIndex?.rowCount ?? 0;
		for (let index = 0; index < count; index += 1) {
			const row = renderUnifiedDiffRow(renderedRowAt(body, index));
			const key = getRenderedSelectionKey(row, file.path, activeTab);
			if (key) keys.push(key);
		}
		this.selectableKeys.set(file.path, keys);
		return keys;
	}
}

function terminalRow(
	options: BuildVirtualRowsOptions,
	file: GitReviewFileSummary,
	body: GitReviewFileBody | undefined,
): GitVirtualFileLimitRow | null {
	const limitReason = body?.limitReason ?? file.limitReason;
	if (limitReason === 'unsupported-file-kind') {
		return fileLimitRow(
			options,
			file,
			limitReason,
			m.git_virtual_diff_unavailable(),
			body?.limitMessage ?? file.limitMessage ?? m.git_virtual_large_diff_unavailable(),
		);
	}
	if (file.isBinary || body?.bodyState === 'binary') {
		return fileLimitRow(
			options,
			file,
			'binary',
			m.git_virtual_binary_file(),
			body?.limitMessage ?? file.limitMessage ?? m.git_virtual_binary_diff_unavailable(),
		);
	}
	if (file.isTooLarge || body?.bodyState === 'too-large') {
		return fileLimitRow(
			options,
			file,
			limitReason ?? 'file-too-many-rows',
			m.git_virtual_large_diff(),
			body?.limitMessage ?? file.limitMessage ?? m.git_virtual_large_diff_unavailable(),
		);
	}
	if (body?.error || body?.bodyState === 'error') {
		return fileLimitRow(
			options,
			file,
			'git-timeout',
			m.git_virtual_diff_failed(),
			body.error ?? m.git_virtual_diff_failed_message(),
		);
	}
	return null;
}

function fileLimitRow(
	options: BuildVirtualRowsOptions,
	file: GitReviewFileSummary,
	reason: GitVirtualFileLimitRow['reason'],
	title: string,
	message: string,
): GitVirtualFileLimitRow {
	return {
		kind: 'file-limit',
		id: `${options.summary.documentId}:file:${encodeURIComponent(file.path)}:limit:${reason}`,
		filePath: file.path,
		estimatedHeight: 112,
		file,
		title,
		message,
		reason,
	};
}

function renderedRowAt(body: GitReviewFileBody, index: number): GitRenderedDiffRow {
	return body.patchIndex!.rowAt(index);
}

function splitEntryIsHunk(
	body: GitReviewFileBody,
	splitIndex: GitSplitPatchIndex,
	index: number,
): boolean {
	const entry = splitIndex.entryAt(index);
	const rowIndex = entry.leftRowIndex ?? entry.rightRowIndex;
	return rowIndex !== null && body.patchIndex!.rowKindAt(rowIndex) === 'hunk';
}

function indexedSplitRow(
	body: GitReviewFileBody,
	splitIndex: GitSplitPatchIndex,
	index: number,
): SplitDiffRow {
	const entry = splitIndex.entryAt(index);
	const left = entry.leftRowIndex === null ? null : renderUnifiedDiffRow(renderedRowAt(body, entry.leftRowIndex));
	const right =
		entry.rightRowIndex === null ? null : renderUnifiedDiffRow(renderedRowAt(body, entry.rightRowIndex));
	if (left?.kind === 'hunk-header') return splitHeader(left);
	if (left?.kind === 'context') return splitContext(left);
	return splitPair(left, right, index);
}

function splitHeader(row: RenderedDiffRow): SplitDiffRow {
	return {
		key: `split:${row.key}`,
		isHeader: true,
		headerText: row.beforeText,
		hunkIndex: row.hunkIndex,
		left: null,
		right: null,
	};
}

function splitContext(row: RenderedDiffRow): SplitDiffRow {
	return {
		key: `split:${row.key}`,
		isHeader: false,
		hunkIndex: row.hunkIndex,
		left: splitCell(row, 'context', 'before'),
		right: splitCell(row, 'context', 'after'),
	};
}

function splitPair(
	deletion: RenderedDiffRow | null | undefined,
	addition: RenderedDiffRow | null | undefined,
	index: number,
): SplitDiffRow {
	return {
		key: `split:pair:${index}:${deletion?.key ?? 'empty'}:${addition?.key ?? 'empty'}`,
		isHeader: false,
		hunkIndex: deletion?.hunkIndex ?? addition?.hunkIndex,
		left: deletion
			? splitCell(deletion, 'del', 'before')
			: { kind: 'empty', line: null, text: '', diffLineIndex: -1 },
		right: addition
			? splitCell(addition, 'add', 'after')
			: { kind: 'empty', line: null, text: '', diffLineIndex: -1 },
	};
}

function splitCell(
	row: RenderedDiffRow,
	kind: SplitDiffCell['kind'],
	side: 'before' | 'after',
): SplitDiffCell {
	return {
		kind,
		line: side === 'before' ? row.beforeLine : row.afterLine,
		text: side === 'before' ? row.beforeText : row.afterText || row.beforeText,
		diffLineIndex: row.diffLineIndex,
	};
}

function interactionForFile(options: BuildVirtualRowsOptions, file: GitReviewFileSummary) {
	const workbench = options.interaction.kind === 'workbench' ? options.interaction : null;
	const activeTab = workbench?.activeTab ?? 'staged';
	const composer =
		options.interaction.kind === 'read-only' ? null : options.interaction.composerState;
	const composerTarget =
		composer?.open && composer.filePath === file.path
			? {
					open: composer.open,
					filePath: composer.filePath,
					side: composer.side,
					line: composer.line,
				}
			: null;
	const common = {
		filePath: file.path,
		activeTab,
		readOnly: !workbench,
		selectedLineKeys: workbench?.selectedLineKeys ?? new Set<string>(),
		composerTarget,
	};
	const actionTarget: GitDiffActionTarget | null = workbench
		? {
				filePath: file.path,
				tab: activeTab,
				mode: activeTab === 'unstaged' ? 'stage' : 'unstage',
				contextLines: options.contextLines,
			}
		: null;
	return {
		activeTab,
		actionTarget,
		viewOptions: common,
		splitViewOptions: common,
	};
}

function estimateViewHeight(isHunkHeader: boolean, showComposer: boolean): number {
	return (isHunkHeader ? 28 : DEFAULT_ROW_HEIGHT) + (showComposer ? 180 : 0);
}

function diffRowId(
	options: BuildVirtualRowsOptions,
	filePath: string,
	rowKey: string,
	mode: 'unified' | 'split',
): string {
	return `${options.summary.documentId}:file:${encodeURIComponent(filePath)}:${mode}:row:${rowKey}`;
}
