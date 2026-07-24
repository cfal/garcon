import type {
	GitRenderedDiffRow,
	GitRenderedDiffRowKind,
	GitRenderedHunk,
} from './git-rendered-diff-types.js';

const NULL_NUMBER = 0xffffffff;
const splitIndexCache = new WeakMap<GitPatchIndex, GitSplitPatchIndex>();

const ROW_KIND = Object.freeze({
	hunk: 0,
	context: 1,
	add: 2,
	del: 3,
});

class GrowingUint32 {
	private values: Uint32Array;
	length = 0;

	constructor(capacity: number) {
		this.values = new Uint32Array(Math.max(1, capacity));
	}

	push(value: number): void {
		if (this.length === this.values.length) {
			const next = new Uint32Array(this.values.length * 2);
			next.set(this.values);
			this.values = next;
		}
		this.values[this.length] = value;
		this.length += 1;
	}

	set(index: number, value: number): void {
		this.values[index] = value;
	}

	finish(): Uint32Array {
		return this.values.slice(0, this.length);
	}
}

class GrowingUint8 {
	private values: Uint8Array;
	length = 0;

	constructor(capacity: number) {
		this.values = new Uint8Array(Math.max(1, capacity));
	}

	push(value: number): void {
		if (this.length === this.values.length) {
			const next = new Uint8Array(this.values.length * 2);
			next.set(this.values);
			this.values = next;
		}
		this.values[this.length] = value;
		this.length += 1;
	}

	finish(): Uint8Array {
		return this.values.slice(0, this.length);
	}
}

export class GitPatchIndex {
	readonly rowCount: number;
	readonly hunkCount: number;

	constructor(
		readonly patch: string,
		private readonly rowKinds: Uint8Array,
		private readonly textStarts: Uint32Array,
		private readonly textEnds: Uint32Array,
		private readonly beforeLines: Uint32Array,
		private readonly afterLines: Uint32Array,
		private readonly hunkIndices: Uint32Array,
		private readonly diffLineIndices: Uint32Array,
		private readonly hunkHeaders: Uint32Array,
		private readonly hunkOldStarts: Uint32Array,
		private readonly hunkOldLines: Uint32Array,
		private readonly hunkNewStarts: Uint32Array,
		private readonly hunkNewLines: Uint32Array,
		private readonly hunkRowEnds: Uint32Array,
	) {
		this.rowCount = rowKinds.length;
		this.hunkCount = hunkHeaders.length;
	}

	rowAt(index: number): GitRenderedDiffRow {
		if (index < 0 || index >= this.rowCount) throw new RangeError(`Invalid diff row ${index}.`);
		const kind = decodeRowKind(this.rowKinds[index]);
		const hunkIndex = this.hunkIndices[index];
		const hunkId = `hunk-${hunkIndex}`;
		const beforeLine = decodeNullable(this.beforeLines[index]);
		const afterLine = decodeNullable(this.afterLines[index]);
		const diffLineIndex = decodeNullable(this.diffLineIndices[index]) ?? -1;
		return {
			key:
				kind === 'hunk'
					? `hunk:${hunkIndex}:${hunkId}`
					: kind === 'context'
						? `line:${diffLineIndex}:context:${beforeLine}:${afterLine}`
						: `line:${diffLineIndex}:${kind}:${kind === 'del' ? beforeLine : afterLine}`,
			kind,
			hunkIndex,
			hunkId,
			beforeLine,
			afterLine,
			text: this.patch.slice(this.textStarts[index], this.textEnds[index]),
			diffLineIndex,
		};
	}

	rowKindAt(index: number): GitRenderedDiffRowKind {
		if (index < 0 || index >= this.rowCount) throw new RangeError(`Invalid diff row ${index}.`);
		return decodeRowKind(this.rowKinds[index]);
	}

	hunkAt(index: number): GitRenderedHunk {
		if (index < 0 || index >= this.hunkCount) throw new RangeError(`Invalid diff hunk ${index}.`);
		const rowStartIndex = this.hunkHeaders[index];
		return {
			id: `hunk-${index}`,
			header: this.patch.slice(this.textStarts[rowStartIndex], this.textEnds[rowStartIndex]),
			oldStart: this.hunkOldStarts[index],
			oldLines: this.hunkOldLines[index],
			newStart: this.hunkNewStarts[index],
			newLines: this.hunkNewLines[index],
			rowStartIndex,
			rowEndIndex: this.hunkRowEnds[index],
		};
	}
}

export interface GitSplitPatchEntry {
	leftRowIndex: number | null;
	rightRowIndex: number | null;
}

export class GitSplitPatchIndex {
	readonly rowCount: number;

	constructor(
		private readonly leftRowIndices: Uint32Array,
		private readonly rightRowIndices: Uint32Array,
	) {
		this.rowCount = leftRowIndices.length;
	}

	entryAt(index: number): GitSplitPatchEntry {
		if (index < 0 || index >= this.rowCount) throw new RangeError(`Invalid split row ${index}.`);
		return {
			leftRowIndex: decodeNullable(this.leftRowIndices[index]),
			rightRowIndex: decodeNullable(this.rightRowIndices[index]),
		};
	}
}

export function createGitPatchIndex(
	patch: string,
	expectedRenderedRowCount?: number,
): GitPatchIndex {
	const initialRows = Math.max(16, expectedRenderedRowCount ?? 0);
	const rowKinds = new GrowingUint8(initialRows);
	const textStarts = new GrowingUint32(initialRows);
	const textEnds = new GrowingUint32(initialRows);
	const beforeLines = new GrowingUint32(initialRows);
	const afterLines = new GrowingUint32(initialRows);
	const hunkIndices = new GrowingUint32(initialRows);
	const diffLineIndices = new GrowingUint32(initialRows);
	const hunkHeaders = new GrowingUint32(16);
	const hunkOldStarts = new GrowingUint32(16);
	const hunkOldLines = new GrowingUint32(16);
	const hunkNewStarts = new GrowingUint32(16);
	const hunkNewLines = new GrowingUint32(16);
	const hunkRowEnds = new GrowingUint32(16);
	let beforeLine = 0;
	let afterLine = 0;
	let diffLineIndex = 0;
	let currentHunkIndex = -1;
	let lineStart = 0;

	while (lineStart < patch.length) {
		const newlineIndex = patch.indexOf('\n', lineStart);
		const lineEnd = newlineIndex < 0 ? patch.length : newlineIndex;
		const line = patch.slice(lineStart, lineEnd);
		if (line.startsWith('diff --git ')) {
			currentHunkIndex = -1;
		} else {
			const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
			if (hunkMatch) {
				currentHunkIndex = hunkHeaders.length;
				beforeLine = Number(hunkMatch[1]);
				afterLine = Number(hunkMatch[3]);
				pushRow({
					rowKinds,
					textStarts,
					textEnds,
					beforeLines,
					afterLines,
					hunkIndices,
					diffLineIndices,
					kind: ROW_KIND.hunk,
					textStart: lineStart,
					textEnd: lineEnd,
					beforeLine: null,
					afterLine: null,
					hunkIndex: currentHunkIndex,
					diffLineIndex: null,
				});
				hunkHeaders.push(rowKinds.length - 1);
				hunkOldStarts.push(Number(hunkMatch[1]));
				hunkOldLines.push(hunkMatch[2] ? Number(hunkMatch[2]) : 1);
				hunkNewStarts.push(Number(hunkMatch[3]));
				hunkNewLines.push(hunkMatch[4] ? Number(hunkMatch[4]) : 1);
				hunkRowEnds.push(rowKinds.length - 1);
			} else if (currentHunkIndex >= 0 && !line.startsWith('\\')) {
				const prefix = line.charAt(0);
				if (prefix === '-' || prefix === '+' || prefix === ' ' || line === '') {
					const kind =
						prefix === '-' ? ROW_KIND.del : prefix === '+' ? ROW_KIND.add : ROW_KIND.context;
					pushRow({
						rowKinds,
						textStarts,
						textEnds,
						beforeLines,
						afterLines,
						hunkIndices,
						diffLineIndices,
						kind,
						textStart: line === '' ? lineStart : lineStart + 1,
						textEnd: lineEnd,
						beforeLine: kind === ROW_KIND.add ? null : beforeLine,
						afterLine: kind === ROW_KIND.del ? null : afterLine,
						hunkIndex: currentHunkIndex,
						diffLineIndex,
					});
					if (kind !== ROW_KIND.add) beforeLine += 1;
					if (kind !== ROW_KIND.del) afterLine += 1;
					diffLineIndex += 1;
					hunkRowEnds.set(currentHunkIndex, rowKinds.length - 1);
				}
			}
		}
		if (newlineIndex < 0) break;
		lineStart = newlineIndex + 1;
	}

	const index = new GitPatchIndex(
		patch,
		rowKinds.finish(),
		textStarts.finish(),
		textEnds.finish(),
		beforeLines.finish(),
		afterLines.finish(),
		hunkIndices.finish(),
		diffLineIndices.finish(),
		hunkHeaders.finish(),
		hunkOldStarts.finish(),
		hunkOldLines.finish(),
		hunkNewStarts.finish(),
		hunkNewLines.finish(),
		hunkRowEnds.finish(),
	);
	if (expectedRenderedRowCount !== undefined && index.rowCount !== expectedRenderedRowCount) {
		throw new Error(
			`Diff row count mismatch: server reported ${expectedRenderedRowCount}, client indexed ${index.rowCount}.`,
		);
	}
	return index;
}

export function getGitSplitPatchIndex(index: GitPatchIndex): GitSplitPatchIndex {
	const cached = splitIndexCache.get(index);
	if (cached) return cached;
	const left = new GrowingUint32(index.rowCount);
	const right = new GrowingUint32(index.rowCount);
	let rowIndex = 0;
	while (rowIndex < index.rowCount) {
		const kind = index.rowKindAt(rowIndex);
		if (kind === 'hunk' || kind === 'context') {
			left.push(rowIndex);
			right.push(rowIndex);
			rowIndex += 1;
			continue;
		}

		const deletionStart = rowIndex;
		while (rowIndex < index.rowCount && index.rowKindAt(rowIndex) === 'del') rowIndex += 1;
		const deletionCount = rowIndex - deletionStart;
		const additionStart = rowIndex;
		while (rowIndex < index.rowCount && index.rowKindAt(rowIndex) === 'add') rowIndex += 1;
		const additionCount = rowIndex - additionStart;
		const pairCount = Math.max(deletionCount, additionCount);
		for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
			left.push(pairIndex < deletionCount ? deletionStart + pairIndex : NULL_NUMBER);
			right.push(pairIndex < additionCount ? additionStart + pairIndex : NULL_NUMBER);
		}
	}
	const splitIndex = new GitSplitPatchIndex(left.finish(), right.finish());
	splitIndexCache.set(index, splitIndex);
	return splitIndex;
}

interface PushRowOptions {
	rowKinds: GrowingUint8;
	textStarts: GrowingUint32;
	textEnds: GrowingUint32;
	beforeLines: GrowingUint32;
	afterLines: GrowingUint32;
	hunkIndices: GrowingUint32;
	diffLineIndices: GrowingUint32;
	kind: number;
	textStart: number;
	textEnd: number;
	beforeLine: number | null;
	afterLine: number | null;
	hunkIndex: number;
	diffLineIndex: number | null;
}

function pushRow(options: PushRowOptions): void {
	options.rowKinds.push(options.kind);
	options.textStarts.push(options.textStart);
	options.textEnds.push(options.textEnd);
	options.beforeLines.push(options.beforeLine ?? NULL_NUMBER);
	options.afterLines.push(options.afterLine ?? NULL_NUMBER);
	options.hunkIndices.push(options.hunkIndex);
	options.diffLineIndices.push(options.diffLineIndex ?? NULL_NUMBER);
}

function decodeNullable(value: number): number | null {
	return value === NULL_NUMBER ? null : value;
}

function decodeRowKind(value: number): GitRenderedDiffRowKind {
	switch (value) {
		case ROW_KIND.hunk:
			return 'hunk';
		case ROW_KIND.context:
			return 'context';
		case ROW_KIND.add:
			return 'add';
		case ROW_KIND.del:
			return 'del';
		default:
			throw new Error(`Unknown diff row kind ${value}.`);
	}
}
