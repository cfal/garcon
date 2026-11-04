import {
	createGitPatchIndex,
	getGitSplitPatchIndex,
	restoreGitPatchIndex,
} from './git-patch-index.js';
import {
	reviewWorkerInputBytes,
	type GitReviewWorkerRequest,
	type GitReviewWorkerReply,
	type GitReviewWorkerOutput,
} from './git-review-worker-protocol.js';
import {
	finishGitReviewPerformanceSpan,
	startGitReviewPerformanceSpan,
	takeGitReviewWorkerTimings,
} from './git-review-performance.js';
import { packGitDiffSyntax, gitDiffSyntaxTransferBuffers } from './git-diff-syntax-transfer.js';

const scope = globalThis as unknown as {
	onmessage: ((event: MessageEvent<GitReviewWorkerRequest>) => void) | null;
	postMessage: (reply: GitReviewWorkerReply, transfer?: Transferable[]) => void;
};

scope.onmessage = async ({ data: { id, input } }) => {
	takeGitReviewWorkerTimings();
	try {
		reviewWorkerInputBytes(input);
		if (input.kind === 'index') {
			const span = startGitReviewPerformanceSpan('patch-index');
			let output: Extract<GitReviewWorkerOutput, { kind: 'index' }>;
			try {
				const index = createGitPatchIndex(input.patch, input.renderedRowCount);
				output = {
					kind: 'index',
					index: index.toData(),
					split: getGitSplitPatchIndex(index).toData(),
				};
			} finally {
				finishGitReviewPerformanceSpan(span);
			}
			scope.postMessage(
				{ id, status: 'ready', output, timings: takeGitReviewWorkerTimings() },
				[...Object.values(output.index), ...Object.values(output.split)].map(
					(array) => array.buffer as ArrayBuffer,
				),
			);
		} else {
			const { highlightGitDiffFile } = await import('./git-diff-syntax-highlighter.js');
			const attempt = await highlightGitDiffFile(
				{
					documentId: input.documentId,
					file: input.file,
					body: { ...input.body, patchIndex: restoreGitPatchIndex(input.body.patch!, input.index) },
				},
				new AbortController().signal,
			);
			const span = startGitReviewPerformanceSpan('syntax-transfer');
			const packed = packGitDiffSyntax(attempt);
			finishGitReviewPerformanceSpan(span);
			scope.postMessage(
				{
					id,
					status: 'ready',
					output: { kind: 'highlight', attempt: packed },
					timings: takeGitReviewWorkerTimings(),
				},
				gitDiffSyntaxTransferBuffers(packed),
			);
		}
	} catch (error) {
		scope.postMessage({
			id,
			status: 'error',
			message: error instanceof Error ? error.message : 'Diff Worker failed.',
		});
	}
};
