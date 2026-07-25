import { readGarconDebugFlag } from '$lib/utils/debug-flags.js';
import type { GitReviewBodyDemand, GitReviewDemandOutcome } from './git-review-body-demand.js';

export const GIT_REVIEW_DEMAND_TRACE_STORAGE_KEY = 'garcon.gitReviewDemandTrace';

export type GitReviewDemandTraceEvent =
	| {
			stage: 'viewport-range';
			layoutIdentity: string | null;
			documentId: string | null;
			active: boolean;
			startIndex: number | null;
			endIndex: number | null;
			rowCount: number;
			scrollTop: number;
			demandEffectRuns: number;
			publications: number;
	  }
	| {
			stage: 'viewport-demand';
			documentId: string;
			kind: GitReviewBodyDemand['kind'];
			fileCount: number;
			firstFile: string | null;
			lastFile: string | null;
	  }
	| {
			stage: 'controller';
			owner: 'workbench' | 'document';
			documentId: string;
			fileCount: number;
			outcome: GitReviewDemandOutcome;
	  }
	| {
			stage: 'scheduler';
			owner: 'workbench' | 'document';
			documentId: string;
			fileCount: number;
			purpose: 'visible' | 'prefetch';
	  };

export interface GitReviewDemandDebugSnapshot {
	documentId: string | null;
	demandedPaths: string[];
	loadingPaths: string[];
	schedulerPendingByPath: Record<string, boolean>;
	readinessGeneration: number;
}

export function isGitReviewDemandTraceEnabled(): boolean {
	return readGarconDebugFlag(GIT_REVIEW_DEMAND_TRACE_STORAGE_KEY);
}

export function traceGitReviewDemand(event: GitReviewDemandTraceEvent): void {
	try {
		if (!isGitReviewDemandTraceEnabled()) return;
		console.debug('git review demand', event);
	} catch {
		// Local diagnostics must not affect review loading.
	}
}

export function unownedGitReviewLoadingPaths(
	loadingPaths: ReadonlySet<string>,
	hasPending: (filePath: string) => boolean,
): string[] {
	return Array.from(loadingPaths).filter((filePath) => !hasPending(filePath));
}

export function assertGitReviewLoadingOwnership(
	loadingPaths: ReadonlySet<string>,
	hasPending: (filePath: string) => boolean,
	owner: string,
): void {
	if (!import.meta.env.DEV) return;
	const unowned = unownedGitReviewLoadingPaths(loadingPaths, hasPending);
	if (unowned.length === 0) return;
	console.error(`Git review loading paths lost scheduler ownership in ${owner}.`, unowned);
}
