import type { GitVirtualReviewRow } from '../git-virtual-review-document.svelte.js';
import {
	virtualMeasurementKey,
	type GitVirtualReviewRowSource,
} from '../git-virtual-review-row-source.js';

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
	const estimateHeight = (row: GitVirtualReviewRow, lineHeight: number): number =>
		row.kind === 'unified-row' || row.kind === 'split-row'
			? Math.max(row.estimatedHeight, lineHeight)
			: row.estimatedHeight;
	return {
		rowCount: rows.length,
		measurementRevision: JSON.stringify(rows.map((row) => [row.id, row.kind, row.estimatedHeight])),
		rowAt: (index) => rows[index] ?? null,
		rowKey: (index) => rows[index]?.id ?? index,
		estimateRowHeight: (index, lineHeight) => {
			const row = rows[index];
			if (!row) return lineHeight;
			return estimateHeight(row, lineHeight);
		},
		buildVirtualMeasurements: (lineHeight) => ({
			keys: rows.map((row) => virtualMeasurementKey(row.id)),
			estimates: rows.map((row) => estimateHeight(row, lineHeight)),
		}),
		fileStart: (filePath) => starts.get(filePath),
		fileState: (filePath) => {
			const fileRows = rows.filter((row) => row.filePath === filePath);
			if (fileRows.some((row) => row.kind === 'file-placeholder')) return 'pending';
			if (fileRows.some((row) => row.kind === 'unified-row' || row.kind === 'split-row')) {
				return 'resolved';
			}
			return 'terminal';
		},
		filePathAt: (index) => rows[index]?.filePath || null,
		filePathsInRange: (start, end) =>
			uniqueFilePaths(rows.slice(clampIndex(start, rows.length), clampIndex(end, rows.length))),
		rowsInRange: (start, end) => rows.slice(start, end),
	};
}

function clampIndex(index: number, rowCount: number): number {
	return Math.min(rowCount, Math.max(0, Math.trunc(index)));
}

function uniqueFilePaths(rows: readonly GitVirtualReviewRow[]): string[] {
	return Array.from(new Set(rows.map((row) => row.filePath).filter(Boolean)));
}
