const MEASURE_PREFIX = 'garcon.git-review.';
const MAX_TRACKED_DOCUMENTS = 128;

export type GitReviewPerformancePhase =
	| 'snapshot'
	| 'body-visible'
	| 'body-prefetch'
	| 'json-decode'
	| 'patch-index';

export interface GitReviewPerformanceSpan {
	phase: GitReviewPerformancePhase;
	startedAt: number;
	startMark: string | null;
}

interface GitReviewDocumentPerformance {
	startedAt: number;
	visibleBodyReadyMeasured: boolean;
	prefetchBodyReadyMeasured: boolean;
	firstRowMeasured: boolean;
	viewportReadyMeasured: boolean;
}

const documents = new Map<string, GitReviewDocumentPerformance>();
let markSequence = 0;

function browserPerformance(): Performance | null {
	return typeof performance === 'undefined' ? null : performance;
}

export function startGitReviewPerformanceSpan(
	phase: GitReviewPerformancePhase,
): GitReviewPerformanceSpan {
	const timing = browserPerformance();
	const startedAt = timing?.now() ?? 0;
	const startMark = timing ? `${MEASURE_PREFIX}${phase}.start.${markSequence++}` : null;
	if (timing && startMark) {
		try {
			timing.mark(startMark);
		} catch {
			return { phase, startedAt, startMark: null };
		}
	}
	return { phase, startedAt, startMark };
}

export function finishGitReviewPerformanceSpan(span: GitReviewPerformanceSpan): void {
	const timing = browserPerformance();
	if (!timing || !span.startMark) return;
	const endMark = `${MEASURE_PREFIX}${span.phase}.end.${markSequence++}`;
	try {
		timing.mark(endMark);
		const measureName = `${MEASURE_PREFIX}${span.phase}`;
		timing.clearMeasures(measureName);
		timing.measure(measureName, span.startMark, endMark);
	} catch {
		// Performance telemetry must never affect the review flow.
	} finally {
		timing.clearMarks(span.startMark);
		timing.clearMarks(endMark);
	}
}

export function registerGitReviewDocument(
	documentId: string,
	snapshotSpan: GitReviewPerformanceSpan,
): void {
	if (!documentId) return;
	documents.delete(documentId);
	documents.set(documentId, {
		startedAt: snapshotSpan.startedAt,
		visibleBodyReadyMeasured: false,
		prefetchBodyReadyMeasured: false,
		firstRowMeasured: false,
		viewportReadyMeasured: false,
	});
	while (documents.size > MAX_TRACKED_DOCUMENTS) {
		const oldest = documents.keys().next().value;
		if (oldest === undefined) break;
		documents.delete(oldest);
	}
}

export function markGitReviewBodyReady(
	documentId: string,
	purpose: 'visible' | 'prefetch',
): void {
	const document = documents.get(documentId);
	if (!document) return;
	const key =
		purpose === 'visible' ? 'visibleBodyReadyMeasured' : 'prefetchBodyReadyMeasured';
	if (document[key]) return;
	document[key] = true;
	markDocumentMilestone(documentId, `${purpose}-body-ready`);
}

export function markGitReviewFirstRow(documentId: string): void {
	const document = documents.get(documentId);
	if (!document || document.firstRowMeasured) return;
	document.firstRowMeasured = true;
	markDocumentMilestone(documentId, 'first-row');
	pruneCompletedDocument(documentId, document);
}

export function markGitReviewViewportReady(documentId: string): void {
	const document = documents.get(documentId);
	if (!document || document.viewportReadyMeasured) return;
	document.viewportReadyMeasured = true;
	markDocumentMilestone(documentId, 'viewport-ready');
	pruneCompletedDocument(documentId, document);
}

function markDocumentMilestone(documentId: string, milestone: string): void {
	const timing = browserPerformance();
	const document = documents.get(documentId);
	if (!timing || !document) return;
	const mark = `${MEASURE_PREFIX}${milestone}.mark.${markSequence++}`;
	try {
		timing.mark(mark);
		const measureName = `${MEASURE_PREFIX}${milestone}`;
		timing.clearMeasures(measureName);
		timing.measure(measureName, {
			start: document.startedAt,
			end: mark,
		});
	} catch {
		// Performance telemetry must never affect the review flow.
	} finally {
		timing.clearMarks(mark);
	}
}

function pruneCompletedDocument(
	documentId: string,
	document: GitReviewDocumentPerformance,
): void {
	if (document.firstRowMeasured && document.viewportReadyMeasured) documents.delete(documentId);
}
