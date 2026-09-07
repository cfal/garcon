import { describe, expect, it, vi } from 'vitest';
import type {
	GitReviewBodyDemand,
	GitReviewDemandOutcome,
} from '$lib/git/review/git-review-body-demand.js';
import { GitReviewDemandReconciler } from '$lib/git/review/git-review-demand-reconciler.js';

function createHarness(initialDocumentId: string | null = null) {
	let documentId = initialDocumentId;
	const viewport = vi.fn<(filePaths: readonly string[]) => GitReviewDemandOutcome>(
		() => 'scheduled',
	);
	const navigation = vi.fn<(filePaths: readonly string[]) => GitReviewDemandOutcome>(
		() => 'scheduled',
	);
	const outcomes: Array<{ demand: GitReviewBodyDemand; outcome: GitReviewDemandOutcome }> = [];
	const reconciler = new GitReviewDemandReconciler({
		currentDocumentId: () => documentId,
		requestViewportPaths: viewport,
		requestNavigationPaths: navigation,
		reportOutcome: (demand, outcome) => outcomes.push({ demand, outcome }),
	});
	return {
		reconciler,
		viewport,
		navigation,
		outcomes,
		setDocumentId: (nextDocumentId: string | null) => {
			documentId = nextDocumentId;
		},
	};
}

describe('GitReviewDemandReconciler', () => {
	it('retains stale demand and reconciles it after readiness changes', () => {
		const harness = createHarness();
		const demand = {
			kind: 'viewport',
			documentId: 'doc-a',
			filePaths: ['visible.ts'],
		} as const;

		harness.reconciler.handle(demand);
		expect(harness.viewport).not.toHaveBeenCalled();
		expect(harness.outcomes.at(-1)?.outcome).toBe('stale-document');

		harness.setDocumentId('doc-a');
		harness.reconciler.markReadinessChanged();

		expect(harness.viewport).toHaveBeenCalledOnce();
		expect(harness.viewport).toHaveBeenCalledWith(['visible.ts']);
		expect(harness.outcomes.at(-1)?.outcome).toBe('scheduled');
	});

	it('does not call the request sink twice for identical demand at one generation', () => {
		const harness = createHarness('doc-a');
		const demand = {
			kind: 'viewport',
			documentId: 'doc-a',
			filePaths: ['visible.ts'],
		} as const;

		harness.reconciler.handle(demand);
		harness.reconciler.handle({
			...demand,
			filePaths: [...demand.filePaths],
		});

		expect(harness.viewport).toHaveBeenCalledOnce();
		expect(harness.outcomes.map(({ outcome }) => outcome)).toEqual([
			'scheduled',
			'already-satisfied',
		]);
	});

	it('reconciles identical retained demand once for each readiness generation', () => {
		const harness = createHarness('doc-a');
		const demand = {
			kind: 'viewport',
			documentId: 'doc-a',
			filePaths: ['visible.ts'],
		} as const;

		harness.reconciler.handle(demand);
		harness.reconciler.markReadinessChanged();
		harness.reconciler.handle(demand);

		expect(harness.viewport).toHaveBeenCalledTimes(2);
		expect(harness.outcomes.at(-1)?.outcome).toBe('already-satisfied');
		expect(harness.reconciler.snapshot()).toEqual({
			documentId: 'doc-a',
			filePaths: ['visible.ts'],
			readinessGeneration: 1,
		});
	});

	it('routes navigation without replacing retained viewport demand', () => {
		const harness = createHarness('doc-a');
		harness.reconciler.handle({
			kind: 'viewport',
			documentId: 'doc-a',
			filePaths: ['viewport.ts'],
		});
		harness.reconciler.handle({
			kind: 'navigation',
			documentId: 'doc-a',
			filePaths: ['target.ts'],
		});
		harness.reconciler.markReadinessChanged();

		expect(harness.navigation).toHaveBeenCalledOnce();
		expect(harness.navigation).toHaveBeenCalledWith(['target.ts']);
		expect(harness.viewport).toHaveBeenNthCalledWith(2, ['viewport.ts']);
		expect(harness.reconciler.snapshot().filePaths).toEqual(['viewport.ts']);
		expect(harness.reconciler.demandsPath('doc-a', 'viewport.ts')).toBe(true);
		expect(harness.reconciler.demandsPath('doc-b', 'viewport.ts')).toBe(false);
	});

	it('clears retained demand and readiness state', () => {
		const harness = createHarness('doc-a');
		harness.reconciler.handle({
			kind: 'viewport',
			documentId: 'doc-a',
			filePaths: ['visible.ts'],
		});
		harness.reconciler.markReadinessChanged();
		harness.viewport.mockClear();

		harness.reconciler.clear();
		harness.reconciler.markReadinessChanged();

		expect(harness.viewport).not.toHaveBeenCalled();
		expect(harness.reconciler.snapshot()).toEqual({
			documentId: null,
			filePaths: [],
			readinessGeneration: 1,
		});
	});
});
