import { DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS, type GitReviewFileBody } from '$lib/api/git.js';
import type { PullRequestDetail } from '$lib/api/pull-requests.js';
import { GitReviewBodyScheduler } from '$lib/git/review/git-review-body-scheduler.js';
import { createIndexedGitReviewFileBody } from '$lib/git/review/git-review-body-index.js';
import { GitDiffSyntaxController } from '$lib/git/review/git-diff-syntax-controller.svelte.js';
import { decideGitReviewBodyBudget } from '$lib/git/review/git-review-body-budget.js';
import type { GitReviewBodyDemand } from '$lib/git/review/git-review-body-demand.js';

type PullRequestDiffDocument = Pick<
	PullRequestDetail,
	'reviewId' | 'documentId' | 'files' | 'fileBodies'
>;

export class PullRequestDiffController {
	fileBodies = $state.raw<Record<string, GitReviewFileBody>>({});
	loadingBodies = $state.raw<Set<string>>(new Set());
	private activeDocumentId = $state<string | null>(null);
	private detail: PullRequestDiffDocument | null = null;
	private scheduler: GitReviewBodyScheduler<GitReviewFileBody> | null = null;
	private demanded = new Set<string>();

	constructor(
		private readonly indexBody = createIndexedGitReviewFileBody,
		readonly syntax = new GitDiffSyntaxController(),
	) {}

	get documentId(): string | null {
		return this.activeDocumentId;
	}

	open(detail: PullRequestDiffDocument): void {
		const previous = this.detail;
		if (
			previous?.reviewId === detail.reviewId &&
			previous.files.length === detail.files.length &&
			previous.files.every(
				(file, index) =>
					sameFields(file, detail.files[index]) &&
					sameFields(previous.fileBodies[file.path], detail.fileBodies[file.path]),
			)
		) {
			// Metadata revisions retain the content document that owns rows and in-flight work.
			this.detail = detail;
			return;
		}
		this.close();
		this.detail = detail;
		this.activeDocumentId = detail.documentId;
		this.syntax.open({ documentId: detail.documentId, files: detail.files }, {});
		this.scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 1,
			load: async ([path], _purpose, signal) => {
				const body = detail.fileBodies[path];
				try {
					return await this.indexBody(body, signal);
				} catch (error) {
					if (signal.aborted) throw error;
					return {
						...body,
						patchIndex: null,
						patch: null,
						bodyState: 'error',
						error: error instanceof Error ? error.message : 'Diff indexing failed.',
					};
				}
			},
			onResult: (body) => {
				const budget = decideGitReviewBodyBudget(
					body,
					'visible',
					this.fileBodies,
					this.demanded,
					DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS,
				);
				const next = { ...this.fileBodies };
				for (const path of budget.evictedPaths) delete next[path];
				if (budget.accept) next[body.path] = body;
				else
					next[body.path] = {
						...body,
						patchIndex: null,
						patch: null,
						bodyState: 'error',
						error: 'Diff exceeds the loaded review budget.',
					};
				for (const path of Object.keys(next)) {
					if (Object.keys(next).length <= 128) break;
					if (!this.demanded.has(path)) delete next[path];
				}
				this.fileBodies = next;
				this.syntax.replaceBodies(next);
			},
			onError: () => undefined,
			onLoadingChange: (paths, loading) => {
				const next = new Set(this.loadingBodies);
				for (const path of paths) {
					if (loading) next.add(path);
					else next.delete(path);
				}
				this.loadingBodies = next;
				if (!loading) this.requestDemanded();
			},
		});
	}

	handleDemand(demand: GitReviewBodyDemand): void {
		if (demand.documentId !== this.activeDocumentId) return;
		this.demanded = new Set(demand.filePaths);
		this.scheduler?.retainVisible(this.demanded);
		this.requestDemanded();
		this.syntax.handleDemand(demand);
	}

	close(): void {
		const scheduler = this.scheduler;
		this.scheduler = null;
		this.detail = null;
		this.activeDocumentId = null;
		this.demanded.clear();
		scheduler?.cancel();
		this.fileBodies = {};
		this.loadingBodies = new Set();
		this.syntax.close();
	}

	private requestDemanded(): void {
		this.scheduler?.requestVisible(
			[...this.demanded].filter((path) => this.detail?.fileBodies[path] && !this.fileBodies[path]),
		);
	}
}

function sameFields<T extends object>(left: T | undefined, right: T | undefined): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	const keys = Object.keys(left) as (keyof T)[];
	return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
