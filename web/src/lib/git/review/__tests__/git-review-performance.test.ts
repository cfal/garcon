import { beforeEach, describe, expect, it } from 'vitest';
import {
	finishGitReviewPerformanceSpan,
	markGitReviewBodyReady,
	markGitReviewFirstRow,
	markGitReviewViewportReady,
	registerGitReviewDocument,
	startGitReviewPerformanceSpan,
} from '$lib/git/review/git-review-performance.js';

beforeEach(() => {
	performance.clearMarks();
	performance.clearMeasures();
});

describe('Git review performance marks', () => {
	it('records a bounded span without retaining its temporary marks', () => {
		const span = startGitReviewPerformanceSpan('patch-index');

		finishGitReviewPerformanceSpan(span);

		expect(performance.getEntriesByName('garcon.git-review.patch-index', 'measure')).toHaveLength(1);
		expect(performance.getEntriesByType('mark')).toHaveLength(0);
	});

	it('measures first-row and viewport readiness from snapshot start', () => {
		const span = startGitReviewPerformanceSpan('snapshot');
		registerGitReviewDocument('document:performance-test', span);
		finishGitReviewPerformanceSpan(span);

		markGitReviewFirstRow('document:performance-test');
		markGitReviewViewportReady('document:performance-test');
		markGitReviewFirstRow('document:performance-test');

		expect(performance.getEntriesByName('garcon.git-review.first-row', 'measure')).toHaveLength(1);
		expect(
			performance.getEntriesByName('garcon.git-review.viewport-ready', 'measure'),
		).toHaveLength(1);
	});

	it('retains only one measurement for repeated phases and body milestones', () => {
		const documentSpan = startGitReviewPerformanceSpan('snapshot');
		registerGitReviewDocument('document:bounded-performance-test', documentSpan);
		finishGitReviewPerformanceSpan(documentSpan);

		for (let index = 0; index < 3; index += 1) {
			const span = startGitReviewPerformanceSpan('json-decode');
			finishGitReviewPerformanceSpan(span);
			markGitReviewBodyReady('document:bounded-performance-test', 'visible');
		}

		expect(performance.getEntriesByName('garcon.git-review.json-decode', 'measure')).toHaveLength(
			1,
		);
		expect(
			performance.getEntriesByName('garcon.git-review.visible-body-ready', 'measure'),
		).toHaveLength(1);
	});
});
