import type { PullRequestDetail } from '$lib/api/pull-requests.js';

export class PullRequestFileProgress {
	viewed = $state<Set<string>>(new Set());
	collapsed = $state<Set<string>>(new Set());
	#reviewId: string | null = null;
	#head: string | null = null;

	selectReview(detail: Pick<PullRequestDetail, 'reviewId' | 'headRefOid'> | null): void {
		const reviewId = detail?.reviewId ?? null;
		const head = detail?.headRefOid ?? null;
		if (this.#reviewId === reviewId && this.#head === head) return;
		this.#reviewId = reviewId;
		this.#head = head;
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
