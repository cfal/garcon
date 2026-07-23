import type { GitRenderedDiffRow } from '$lib/api/git.js';

const NEARBY_ROW_COUNT = 2;

export function buildGitReviewCommentContext(
	rows: GitRenderedDiffRow[],
	side: 'before' | 'after',
	line: number,
): string[] {
	const targetIndex = rows.findIndex((row) =>
		side === 'before' ? row.beforeLine === line : row.afterLine === line,
	);
	if (targetIndex < 0) return [];
	const target = rows[targetIndex];
	if (!target || target.kind === 'hunk') return [];
	const hunkRows = rows
		.map((row, index) => ({ row, index }))
		.filter(({ row }) => row.kind !== 'hunk' && row.hunkId === target.hunkId);
	const targetPosition = hunkRows.findIndex(({ index }) => index === targetIndex);
	const nearby = hunkRows.slice(
		Math.max(0, targetPosition - NEARBY_ROW_COUNT),
		targetPosition + NEARBY_ROW_COUNT + 1,
	);
	const hunkHeader = rows.find(
		(row) => row.kind === 'hunk' && row.hunkId === target.hunkId,
	);
	return [
		...(hunkHeader ? [hunkHeader.text] : []),
		...nearby.map(({ row }) => formatContextRow(row)),
	];
}

export function formatGitReviewCommentContext(contextLines: string[]): string[] {
	if (contextLines.length === 0) return [];
	const longestFence = contextLines.reduce((longest, line) => {
		const runs = line.match(/`+/g) ?? [];
		return Math.max(longest, ...runs.map((run) => run.length));
	}, 0);
	const fence = '`'.repeat(Math.max(3, longestFence + 1));
	return ['', 'Context:', `${fence}diff`, ...contextLines, fence];
}

export function formatGitReviewInlineCode(value: string): string {
	const runs = value.match(/`+/g) ?? [];
	const longestRun = Math.max(0, ...runs.map((run) => run.length));
	const fence = '`'.repeat(longestRun + 1);
	const needsPadding = value.startsWith('`') || value.endsWith('`');
	return `${fence}${needsPadding ? ' ' : ''}${value}${needsPadding ? ' ' : ''}${fence}`;
}

function formatContextRow(row: GitRenderedDiffRow): string {
	if (row.kind === 'add') return `+${row.text}`;
	if (row.kind === 'del') return `-${row.text}`;
	return ` ${row.text}`;
}
