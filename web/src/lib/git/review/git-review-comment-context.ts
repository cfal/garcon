import type { GitReviewFileBody } from '$lib/api/git.js';
import type { GitRenderedDiffRow } from './git-rendered-diff-types.js';

const NEARBY_ROW_COUNT = 2;

export function buildGitReviewCommentContext(
	rows: GitRenderedDiffRow[],
	side: 'before' | 'after',
	line: number,
): string[] {
	return buildCommentContext(rows.length, (index) => rows[index], side, line);
}

export function buildGitReviewBodyCommentContext(
	body: GitReviewFileBody | undefined,
	side: 'before' | 'after',
	line: number,
): string[] {
	if (!body?.patchIndex) return [];
	const index = body.patchIndex;
	return buildCommentContext(
		index.rowCount,
		(rowIndex) => index.rowAt(rowIndex),
		side,
		line,
	);
}

function buildCommentContext(
	rowCount: number,
	rowAt: (index: number) => GitRenderedDiffRow | undefined,
	side: 'before' | 'after',
	line: number,
): string[] {
	let hunkHeaderIndex = -1;
	let hunkHeaderText: string | null = null;
	let targetIndex = -1;
	for (let index = 0; index < rowCount; index += 1) {
		const row = rowAt(index);
		if (!row) continue;
		if (row.kind === 'hunk') {
			hunkHeaderIndex = index;
			hunkHeaderText = row.text;
			continue;
		}
		if (side === 'before' ? row.beforeLine === line : row.afterLine === line) {
			targetIndex = index;
			break;
		}
	}
	if (targetIndex < 0) return [];
	const target = rowAt(targetIndex);
	if (!target || target.kind === 'hunk') return [];
	const nearby: GitRenderedDiffRow[] = [];
	const start = Math.max(hunkHeaderIndex + 1, targetIndex - NEARBY_ROW_COUNT);
	const end = Math.min(rowCount, targetIndex + NEARBY_ROW_COUNT + 1);
	for (let index = start; index < end; index += 1) {
		const row = rowAt(index);
		if (!row || row.kind === 'hunk' || row.hunkId !== target.hunkId) continue;
		nearby.push(row);
	}
	return [
		...(hunkHeaderText ? [hunkHeaderText] : []),
		...nearby.map(formatContextRow),
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
