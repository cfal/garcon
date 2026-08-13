import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import type { CodeHighlightSegment } from '$lib/highlighting/code-highlight-types.js';

export const GIT_DIFF_SYNTAX_VERSION = 1;

export const GIT_DIFF_SYNTAX_LIMITS = Object.freeze({
	maxRenderedRows: 2_000,
	maxSyntheticCharactersPerSide: 200_000,
	maxSegmentsPerSide: 50_000,
	parseTimeoutMs: 12,
	workSlotTimeoutMs: 100,
});

export type GitDiffSyntaxFile = Pick<
	GitReviewFileSummary,
	| 'path'
	| 'originalPath'
	| 'bodyFingerprint'
	| 'category'
	| 'isGenerated'
	| 'isBinary'
	| 'isTooLarge'
>;

export interface GitDiffSyntaxDocument {
	documentId: string;
	files: readonly GitDiffSyntaxFile[];
}

export interface GitDiffSyntaxFileInput {
	documentId: string;
	file: GitDiffSyntaxFile;
	body: GitReviewFileBody;
}

export interface GitDiffSyntheticLine {
	text: string;
	diffLineIndex: number | null;
}

export interface GitDiffSyntheticSide {
	text: string;
	lines: readonly GitDiffSyntheticLine[];
	characterCount: number;
}

export interface GitDiffSyntheticSides {
	before: GitDiffSyntheticSide | null;
	after: GitDiffSyntheticSide | null;
}

export interface GitDiffSyntheticSidesResult {
	sides: GitDiffSyntheticSides;
	beforeExceeded: boolean;
	afterExceeded: boolean;
}

export interface GitDiffSyntaxSideResult {
	path: string;
	languageKey: string;
	lines: ReadonlyMap<number, readonly CodeHighlightSegment[]>;
	characterCount: number;
	segmentCount: number;
}

export interface GitDiffFileSyntaxResult {
	cacheKey: string;
	filePath: string;
	bodyFingerprint: string;
	before: GitDiffSyntaxSideResult | null;
	after: GitDiffSyntaxSideResult | null;
	characterCount: number;
	segmentCount: number;
}

export type GitDiffSyntaxResults = Readonly<Record<string, GitDiffFileSyntaxResult>>;

export type GitDiffSyntaxPlainReason =
	| 'excluded'
	| 'row-limit'
	| 'character-limit'
	| 'unsupported-language'
	| 'parse-timeout'
	| 'segment-limit'
	| 'invalid-segment-text'
	| 'error';

export type GitDiffSyntaxSideAttempt =
	| { status: 'highlighted'; result: GitDiffSyntaxSideResult }
	| {
			status: 'plain';
			reason: 'parse-timeout' | 'segment-limit' | 'invalid-segment-text' | 'error';
	  };

export type GitDiffSyntaxAttempt =
	| { status: 'highlighted'; result: GitDiffFileSyntaxResult }
	| { status: 'plain'; reason: GitDiffSyntaxPlainReason }
	| { status: 'cancelled' };

export function gitDiffSyntaxSkipReason(
	input: GitDiffSyntaxFileInput,
): GitDiffSyntaxPlainReason | null {
	const { file, body } = input;
	if (
		body.bodyState !== 'loaded' ||
		body.patch === null ||
		body.bodyFingerprint !== file.bodyFingerprint ||
		body.isBinary ||
		body.isTooLarge ||
		file.isGenerated ||
		file.isBinary ||
		file.isTooLarge ||
		file.category === 'generated' ||
		file.category === 'lockfile' ||
		file.category === 'binary' ||
		file.category === 'large' ||
		body.category === 'generated' ||
		body.category === 'lockfile' ||
		body.category === 'binary' ||
		body.category === 'large'
	) {
		return 'excluded';
	}
	return body.renderedRowCount > GIT_DIFF_SYNTAX_LIMITS.maxRenderedRows ? 'row-limit' : null;
}

export function gitDiffSyntaxCacheKey(
	documentId: string,
	file: GitDiffSyntaxFile,
	body: GitReviewFileBody,
): string {
	return JSON.stringify([
		GIT_DIFF_SYNTAX_VERSION,
		documentId,
		body.bodyFingerprint,
		file.originalPath ?? file.path,
		file.path,
	]);
}

class SyntheticSideBuilder {
	private readonly lines: GitDiffSyntheticLine[] = [];
	private lastHunkIndex: number | null = null;
	private characterCount = 0;
	private exceeded = false;

	append(text: string, diffLineIndex: number, hunkIndex: number): void {
		if (this.exceeded) return;
		if (this.lastHunkIndex !== null && this.lastHunkIndex !== hunkIndex) {
			this.push({ text: '', diffLineIndex: null });
		}
		this.push({ text, diffLineIndex });
		this.lastHunkIndex = hunkIndex;
	}

	finish(): GitDiffSyntheticSide | null {
		if (this.exceeded || this.lines.length === 0) return null;
		return {
			lines: this.lines,
			text: this.lines.map((line) => line.text).join('\n'),
			characterCount: this.characterCount,
		};
	}

	get didExceedLimit(): boolean {
		return this.exceeded;
	}

	private push(line: GitDiffSyntheticLine): void {
		if (this.exceeded) return;
		const separatorCharacters = this.lines.length === 0 ? 0 : 1;
		this.characterCount += separatorCharacters + line.text.length;
		if (this.characterCount > GIT_DIFF_SYNTAX_LIMITS.maxSyntheticCharactersPerSide) {
			this.exceeded = true;
			this.lines.length = 0;
			return;
		}
		this.lines.push(line);
	}
}

export function buildGitDiffSyntheticSides(body: GitReviewFileBody): GitDiffSyntheticSidesResult {
	if (body.bodyState !== 'loaded' || body.patch === null) {
		return {
			sides: { before: null, after: null },
			beforeExceeded: false,
			afterExceeded: false,
		};
	}

	const patchIndex = body.patchIndex;
	if (!patchIndex) {
		return {
			sides: { before: null, after: null },
			beforeExceeded: false,
			afterExceeded: false,
		};
	}

	const before = new SyntheticSideBuilder();
	const after = new SyntheticSideBuilder();
	for (let index = 0; index < patchIndex.rowCount; index += 1) {
		const row = patchIndex.rowAt(index);
		if (row.kind === 'hunk') continue;
		if (row.kind === 'context' || row.kind === 'del') {
			before.append(row.text, row.diffLineIndex, row.hunkIndex);
		}
		if (row.kind === 'context' || row.kind === 'add') {
			after.append(row.text, row.diffLineIndex, row.hunkIndex);
		}
	}

	return {
		sides: { before: before.finish(), after: after.finish() },
		beforeExceeded: before.didExceedLimit,
		afterExceeded: after.didExceedLimit,
	};
}

export function waitForGitDiffSyntaxWorkSlot(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		let idleId: number | null = null;
		let timerId: ReturnType<typeof setTimeout> | null = null;
		let settled = false;

		const finish = (): void => {
			if (settled) return;
			settled = true;
			if (idleId !== null) cancelIdleCallback(idleId);
			if (timerId !== null) clearTimeout(timerId);
			signal.removeEventListener('abort', finish);
			resolve();
		};

		signal.addEventListener('abort', finish, { once: true });
		if (typeof requestIdleCallback === 'function') {
			idleId = requestIdleCallback(finish, {
				timeout: GIT_DIFF_SYNTAX_LIMITS.workSlotTimeoutMs,
			});
		} else {
			timerId = setTimeout(finish, 0);
		}
	});
}
