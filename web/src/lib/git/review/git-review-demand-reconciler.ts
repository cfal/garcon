import type {
	GitReviewBodyDemand,
	GitReviewDemandOutcome,
	GitReviewViewportDemand,
} from './git-review-body-demand.js';
import { sameGitReviewViewportDemand } from './git-review-body-demand.js';

interface GitReviewDemandReconcilerOptions {
	currentDocumentId: () => string | null;
	requestViewportPaths: (filePaths: readonly string[]) => GitReviewDemandOutcome;
	requestNavigationPaths: (filePaths: readonly string[]) => GitReviewDemandOutcome;
	reportOutcome: (demand: GitReviewBodyDemand, outcome: GitReviewDemandOutcome) => void;
}

export interface GitReviewDemandReconcilerSnapshot {
	documentId: string | null;
	filePaths: string[];
	readinessGeneration: number;
}

export class GitReviewDemandReconciler {
	private viewportDemand: GitReviewViewportDemand | null = null;
	private readinessGeneration = 0;
	private lastReconciledDemand: GitReviewViewportDemand | null = null;
	private lastReconciledReadinessGeneration = -1;

	constructor(private readonly options: GitReviewDemandReconcilerOptions) {}

	handle(demand: GitReviewBodyDemand): void {
		if (demand.kind === 'navigation') {
			const outcome =
				demand.documentId === this.options.currentDocumentId()
					? this.options.requestNavigationPaths(demand.filePaths)
					: 'stale-document';
			this.options.reportOutcome(demand, outcome);
			return;
		}

		if (!sameGitReviewViewportDemand(this.viewportDemand, demand)) {
			this.viewportDemand = copyViewportDemand(demand);
		}
		this.reconcile();
	}

	markReadinessChanged(): void {
		this.readinessGeneration += 1;
		this.reconcile();
	}

	clear(): void {
		this.viewportDemand = null;
		this.lastReconciledDemand = null;
		this.readinessGeneration = 0;
		this.lastReconciledReadinessGeneration = -1;
	}

	demandsPath(documentId: string, filePath: string): boolean {
		return (
			this.viewportDemand?.documentId === documentId &&
			this.viewportDemand.filePaths.includes(filePath)
		);
	}

	snapshot(): GitReviewDemandReconcilerSnapshot {
		return {
			documentId: this.viewportDemand?.documentId ?? null,
			filePaths: [...(this.viewportDemand?.filePaths ?? [])],
			readinessGeneration: this.readinessGeneration,
		};
	}

	private reconcile(): void {
		const demand = this.viewportDemand;
		if (!demand) return;
		if (
			sameGitReviewViewportDemand(this.lastReconciledDemand, demand) &&
			this.lastReconciledReadinessGeneration === this.readinessGeneration
		) {
			this.options.reportOutcome(demand, 'already-satisfied');
			return;
		}

		// Records the attempt before the sink can rebuild the reactive row source.
		this.lastReconciledDemand = copyViewportDemand(demand);
		this.lastReconciledReadinessGeneration = this.readinessGeneration;

		if (demand.documentId !== this.options.currentDocumentId()) {
			this.options.reportOutcome(demand, 'stale-document');
			return;
		}
		const outcome = this.options.requestViewportPaths(demand.filePaths);
		this.options.reportOutcome(demand, outcome);
	}
}

function copyViewportDemand(demand: GitReviewViewportDemand): GitReviewViewportDemand {
	return {
		kind: 'viewport',
		documentId: demand.documentId,
		filePaths: [...demand.filePaths],
	};
}
