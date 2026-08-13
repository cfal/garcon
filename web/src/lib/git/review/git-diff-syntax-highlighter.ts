import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, Text } from '@codemirror/state';
import { highlightCode } from '@lezer/highlight';

import { codeTagHighlighter } from '$lib/highlighting/codemirror-code-highlighter.js';
import {
	appendCodeHighlightSegment,
	type CodeHighlightSegment,
} from '$lib/highlighting/code-highlight-types.js';
import {
	loadCodeMirrorLanguageForFile,
	type LoadedCodeMirrorLanguage,
} from '$lib/highlighting/codemirror-language-registry.js';
import {
	finishGitReviewPerformanceSpan,
	startGitReviewPerformanceSpan,
} from './git-review-performance.js';
import {
	GIT_DIFF_SYNTAX_LIMITS,
	buildGitDiffSyntheticSides,
	gitDiffSyntaxCacheKey,
	gitDiffSyntaxSkipReason,
	waitForGitDiffSyntaxWorkSlot,
	type GitDiffSyntheticSide,
	type GitDiffSyntaxAttempt,
	type GitDiffSyntaxFileInput,
	type GitDiffSyntaxPlainReason,
	type GitDiffSyntaxSideAttempt,
	type GitDiffSyntaxSideResult,
} from './git-diff-syntax.js';

export interface GitDiffSyntaxHighlightDependencies {
	loadLanguage: (filePath: string) => Promise<LoadedCodeMirrorLanguage | null>;
	waitForWorkSlot: (signal: AbortSignal) => Promise<void>;
	highlightSide: (
		side: GitDiffSyntheticSide,
		path: string,
		loaded: LoadedCodeMirrorLanguage,
	) => GitDiffSyntaxSideAttempt;
}

const DEFAULT_GIT_DIFF_SYNTAX_HIGHLIGHT_DEPENDENCIES = {
	loadLanguage: loadCodeMirrorLanguageForFile,
	waitForWorkSlot: waitForGitDiffSyntaxWorkSlot,
	highlightSide: highlightGitDiffSyntheticSide,
} satisfies GitDiffSyntaxHighlightDependencies;

export function highlightGitDiffSyntheticSide(
	side: GitDiffSyntheticSide,
	path: string,
	loaded: LoadedCodeMirrorLanguage,
): GitDiffSyntaxSideAttempt {
	const editorState = EditorState.create({
		doc: Text.of(side.lines.map((line) => line.text)),
		extensions: loaded.language.extension,
	});
	if (editorState.doc.length !== side.text.length) {
		return { status: 'plain', reason: 'invalid-segment-text' };
	}
	const parseSpan = startGitReviewPerformanceSpan('syntax-parse');
	let tree;
	try {
		tree = ensureSyntaxTree(
			editorState,
			editorState.doc.length,
			GIT_DIFF_SYNTAX_LIMITS.parseTimeoutMs,
		);
	} finally {
		finishGitReviewPerformanceSpan(parseSpan);
	}
	if (!tree) return { status: 'plain', reason: 'parse-timeout' };

	const projectSpan = startGitReviewPerformanceSpan('syntax-project');
	try {
		const highlightedLines = new Map<number, readonly CodeHighlightSegment[]>();
		let currentSegments: CodeHighlightSegment[] = [];
		let syntheticLineIndex = 0;
		let segmentCount = 0;
		let invalidText = false;
		let segmentLimitExceeded = false;

		const finishLine = (): void => {
			const sourceLine = side.lines[syntheticLineIndex];
			if (!sourceLine) {
				invalidText = true;
				return;
			}
			const highlightedText = currentSegments.map((segment) => segment.text).join('');
			if (highlightedText !== sourceLine.text) invalidText = true;
			if (sourceLine.diffLineIndex !== null) {
				highlightedLines.set(sourceLine.diffLineIndex, currentSegments);
			}
			segmentCount += currentSegments.length;
			if (segmentCount > GIT_DIFF_SYNTAX_LIMITS.maxSegmentsPerSide) {
				segmentLimitExceeded = true;
			}
			currentSegments = [];
			syntheticLineIndex += 1;
		};

		highlightCode(
			side.text,
			tree,
			codeTagHighlighter,
			(text, classes) => appendCodeHighlightSegment(currentSegments, text, classes || null),
			finishLine,
		);
		finishLine();

		if (segmentLimitExceeded) return { status: 'plain', reason: 'segment-limit' };
		if (invalidText || syntheticLineIndex !== side.lines.length) {
			return { status: 'plain', reason: 'invalid-segment-text' };
		}
		return {
			status: 'highlighted',
			result: {
				path,
				languageKey: loaded.key,
				lines: highlightedLines,
				characterCount: side.characterCount,
				segmentCount,
			},
		};
	} finally {
		finishGitReviewPerformanceSpan(projectSpan);
	}
}

export async function highlightGitDiffFile(
	input: GitDiffSyntaxFileInput,
	signal: AbortSignal,
	deps: GitDiffSyntaxHighlightDependencies = DEFAULT_GIT_DIFF_SYNTAX_HIGHLIGHT_DEPENDENCIES,
): Promise<GitDiffSyntaxAttempt> {
	const { documentId, file, body } = input;
	if (signal.aborted) return { status: 'cancelled' };
	const skipReason = gitDiffSyntaxSkipReason(input);
	if (skipReason) return { status: 'plain', reason: skipReason };

	try {
		await deps.waitForWorkSlot(signal);
		if (signal.aborted) return { status: 'cancelled' };

		const reconstructSpan = startGitReviewPerformanceSpan('syntax-reconstruct');
		let reconstructed;
		try {
			reconstructed = buildGitDiffSyntheticSides(body);
		} finally {
			finishGitReviewPerformanceSpan(reconstructSpan);
		}

		const beforePath = file.originalPath ?? file.path;
		const afterPath = file.path;
		const languageLoads = new Map<string, Promise<LoadedCodeMirrorLanguage | null>>();
		const load = (path: string): Promise<LoadedCodeMirrorLanguage | null> => {
			const existing = languageLoads.get(path);
			if (existing) return existing;
			const pending = deps.loadLanguage(path);
			languageLoads.set(path, pending);
			return pending;
		};

		const languageSpan = startGitReviewPerformanceSpan('syntax-language-load');
		let loadedAfter: LoadedCodeMirrorLanguage | null;
		let loadedBefore: LoadedCodeMirrorLanguage | null;
		try {
			[loadedAfter, loadedBefore] = await Promise.all([
				reconstructed.sides.after ? load(afterPath) : Promise.resolve(null),
				reconstructed.sides.before ? load(beforePath) : Promise.resolve(null),
			]);
		} finally {
			finishGitReviewPerformanceSpan(languageSpan);
		}
		if (signal.aborted) return { status: 'cancelled' };

		const plainReasons: GitDiffSyntaxPlainReason[] = [];
		const runSide = async (
			side: GitDiffSyntheticSide | null,
			path: string,
			loaded: LoadedCodeMirrorLanguage | null,
		): Promise<GitDiffSyntaxSideResult | null> => {
			if (!side) return null;
			if (!loaded) {
				plainReasons.push('unsupported-language');
				return null;
			}
			await deps.waitForWorkSlot(signal);
			if (signal.aborted) return null;
			try {
				const attempt = deps.highlightSide(side, path, loaded);
				if (attempt.status === 'plain') {
					plainReasons.push(attempt.reason);
					return null;
				}
				return attempt.result;
			} catch {
				plainReasons.push('error');
				return null;
			}
		};

		const after = await runSide(reconstructed.sides.after, afterPath, loadedAfter);
		if (signal.aborted) return { status: 'cancelled' };
		const before = await runSide(reconstructed.sides.before, beforePath, loadedBefore);
		if (signal.aborted) return { status: 'cancelled' };

		if (!before && !after) {
			return {
				status: 'plain',
				reason:
					reconstructed.beforeExceeded || reconstructed.afterExceeded
						? 'character-limit'
						: (plainReasons[0] ?? 'excluded'),
			};
		}

		return {
			status: 'highlighted',
			result: {
				cacheKey: gitDiffSyntaxCacheKey(documentId, file, body),
				filePath: file.path,
				bodyFingerprint: body.bodyFingerprint,
				before,
				after,
				characterCount: (before?.characterCount ?? 0) + (after?.characterCount ?? 0),
				segmentCount: (before?.segmentCount ?? 0) + (after?.segmentCount ?? 0),
			},
		};
	} catch {
		return signal.aborted ? { status: 'cancelled' } : { status: 'plain', reason: 'error' };
	}
}
