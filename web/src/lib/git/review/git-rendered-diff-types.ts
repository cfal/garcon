export type GitRenderedDiffRowKind = 'hunk' | 'context' | 'add' | 'del';

export interface GitRenderedDiffRow {
	key: string;
	kind: GitRenderedDiffRowKind;
	hunkIndex: number;
	hunkId: string;
	beforeLine: number | null;
	afterLine: number | null;
	text: string;
	diffLineIndex: number;
}

export interface GitRenderedHunk {
	id: string;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	rowStartIndex: number;
	rowEndIndex: number;
}
