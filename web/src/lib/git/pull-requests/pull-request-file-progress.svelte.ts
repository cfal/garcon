import type { PullRequestDetail } from '$lib/api/pull-requests.js';

export class PullRequestFileProgress {
	viewed = $state<Set<string>>(new Set());
	collapsed = $state<Set<string>>(new Set());
	#reviewId: string | null = null;
	#head: string | null = null;
	#fingerprints = new Map<string, string>();

	selectReview(detail: Pick<PullRequestDetail, 'reviewId' | 'headRefOid' | 'files'> | null): void {
		const reviewId = detail?.reviewId ?? null;
		const head = detail?.headRefOid ?? null;
		const files = detail?.files ?? [];
		if (
			this.#reviewId === reviewId && this.#head === head &&
			this.#fingerprints.size === files.length &&
			files.every((file) => this.#fingerprints.get(file.path) === file.bodyFingerprint)
		) return;
		this.#reviewId = reviewId;
		this.#head = head;
		this.#fingerprints = new Map(files.map((file) => [file.path, file.bodyFingerprint]));
		this.viewed = new Set();
		this.collapsed = new Set();
	}

	toggleViewed(path: string): void {
		const viewed = new Set(this.viewed);
		const collapsed = new Set(this.collapsed);
		if (viewed.delete(path)) collapsed.delete(path);
		else {
			viewed.add(path);
			collapsed.add(path);
		}
		this.viewed = viewed;
		this.collapsed = collapsed;
	}

	toggleCollapsed(path: string): void {
		const collapsed = new Set(this.collapsed);
		if (!collapsed.delete(path)) collapsed.add(path);
		this.collapsed = collapsed;
	}
}
