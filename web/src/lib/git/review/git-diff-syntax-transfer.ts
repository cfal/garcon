import type { CodeHighlightSegment } from '$lib/highlighting/code-highlight-types.js';
import type {
	GitDiffFileSyntaxResult,
	GitDiffSyntaxAttempt,
	GitDiffSyntaxSideResult,
} from './git-diff-syntax.js';

export interface GitDiffSyntaxSideData extends Omit<GitDiffSyntaxSideResult, 'lines'> {
	text: string;
	lineNumbers: Uint32Array;
	lineSegments: Uint32Array;
	textEnds: Uint32Array;
	classIndices: Uint32Array;
	classes: (string | null)[];
}

export type GitDiffSyntaxTransfer =
	| Exclude<GitDiffSyntaxAttempt, { status: 'highlighted' }>
	| {
			status: 'highlighted';
			result: Omit<GitDiffFileSyntaxResult, 'before' | 'after'> & {
				before: GitDiffSyntaxSideData | null;
				after: GitDiffSyntaxSideData | null;
			};
	  };

function packSide(side: GitDiffSyntaxSideResult | null): GitDiffSyntaxSideData | null {
	if (!side) return null;
	const lineNumbers = new Uint32Array(side.lines.size);
	const lineSegments = new Uint32Array(side.lines.size + 1);
	const textEnds = new Uint32Array(side.segmentCount);
	const classIndices = new Uint32Array(side.segmentCount);
	const classes: (string | null)[] = [];
	const classIds = new Map<string | null, number>();
	const text: string[] = [];
	let lineIndex = 0;
	let segmentIndex = 0;
	let offset = 0;
	// Projection emits ascending diff-line indexes for binary-search hydration.
	for (const [line, segments] of side.lines) {
		lineNumbers[lineIndex] = line;
		lineSegments[lineIndex++] = segmentIndex;
		for (const segment of segments) {
			let classId = classIds.get(segment.className);
			if (classId === undefined) {
				classId = classes.length;
				classes.push(segment.className);
				classIds.set(segment.className, classId);
			}
			text.push(segment.text);
			offset += segment.text.length;
			textEnds[segmentIndex] = offset;
			classIndices[segmentIndex++] = classId;
		}
	}
	lineSegments[lineIndex] = segmentIndex;
	const { lines: _lines, ...metadata } = side;
	return {
		...metadata,
		text: text.join(''),
		lineNumbers,
		lineSegments,
		textEnds: textEnds.subarray(0, segmentIndex),
		classIndices: classIndices.subarray(0, segmentIndex),
		classes,
	};
}

export function packGitDiffSyntax(attempt: GitDiffSyntaxAttempt): GitDiffSyntaxTransfer {
	if (attempt.status !== 'highlighted') return attempt;
	return {
		status: 'highlighted',
		result: {
			...attempt.result,
			before: packSide(attempt.result.before),
			after: packSide(attempt.result.after),
		},
	};
}

export function gitDiffSyntaxTransferBuffers(attempt: GitDiffSyntaxTransfer): ArrayBuffer[] {
	if (attempt.status !== 'highlighted') return [];
	return [attempt.result.before, attempt.result.after].flatMap((side) =>
		side
			? ([
					side.lineNumbers.buffer,
					side.lineSegments.buffer,
					side.textEnds.buffer,
					side.classIndices.buffer,
				] as ArrayBuffer[])
			: [],
	);
}

class GitDiffSyntaxLines implements ReadonlyMap<number, readonly CodeHighlightSegment[]> {
	readonly [Symbol.toStringTag] = 'GitDiffSyntaxLines';
	constructor(private readonly data: GitDiffSyntaxSideData) {}
	get size(): number {
		return this.data.lineNumbers.length;
	}
	private indexOf(line: number): number {
		if (!Number.isInteger(line)) return -1;
		let low = 0;
		let high = this.size - 1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			const candidate = this.data.lineNumbers[middle];
			if (candidate < line) low = middle + 1;
			else if (candidate > line) high = middle - 1;
			else return middle;
		}
		return -1;
	}
	has(line: number): boolean {
		return this.indexOf(line) >= 0;
	}
	get(line: number): readonly CodeHighlightSegment[] | undefined {
		const index = this.indexOf(line);
		if (index < 0) return undefined;
		const segments: CodeHighlightSegment[] = [];
		for (
			let segment = this.data.lineSegments[index];
			segment < this.data.lineSegments[index + 1];
			segment += 1
		) {
			segments.push({
				text: this.data.text.slice(
					segment === 0 ? 0 : this.data.textEnds[segment - 1],
					this.data.textEnds[segment],
				),
				className: this.data.classes[this.data.classIndices[segment]],
			});
		}
		return segments;
	}
	*keys(): MapIterator<number> {
		yield* this.data.lineNumbers;
	}
	*values(): MapIterator<readonly CodeHighlightSegment[]> {
		for (const line of this.keys()) yield this.get(line)!;
	}
	*entries(): MapIterator<[number, readonly CodeHighlightSegment[]]> {
		for (const line of this.keys()) yield [line, this.get(line)!];
	}
	[Symbol.iterator](): MapIterator<[number, readonly CodeHighlightSegment[]]> {
		return this.entries();
	}
	forEach(
		callback: (
			value: readonly CodeHighlightSegment[],
			key: number,
			map: ReadonlyMap<number, readonly CodeHighlightSegment[]>,
		) => void,
		thisArg?: unknown,
	): void {
		for (const [line, segments] of this) callback.call(thisArg, segments, line, this);
	}
}

function restoreSide(side: GitDiffSyntaxSideData | null): GitDiffSyntaxSideResult | null {
	if (!side) return null;
	return {
		path: side.path,
		languageKey: side.languageKey,
		characterCount: side.characterCount,
		segmentCount: side.segmentCount,
		lines: new GitDiffSyntaxLines(side),
	};
}

export function restoreGitDiffSyntax(attempt: GitDiffSyntaxTransfer): GitDiffSyntaxAttempt {
	if (attempt.status !== 'highlighted') return attempt;
	return {
		status: 'highlighted',
		result: {
			...attempt.result,
			before: restoreSide(attempt.result.before),
			after: restoreSide(attempt.result.after),
		},
	};
}
