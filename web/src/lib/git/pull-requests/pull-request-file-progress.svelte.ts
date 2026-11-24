export class PullRequestFileProgress {
	viewed = $state<Set<string>>(new Set());
	collapsed = $state<Set<string>>(new Set());
	#reviewId: string | null = null;

	selectReview(reviewId: string | null): void {
		if (this.#reviewId === reviewId) return;
		this.#reviewId = reviewId;
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
