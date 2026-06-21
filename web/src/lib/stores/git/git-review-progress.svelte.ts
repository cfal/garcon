import type { GitDiffTab, GitFileReviewData, GitTreeNode } from '$lib/api/git.js';

export interface ViewedFileRecord {
	path: string;
	tab: GitDiffTab;
	signature: string;
	viewedAt: string;
}

export class GitReviewProgress {
	hideViewed = $state(false);
	showGenerated = $state(false);
	private viewedByKey = $state(new Map<string, ViewedFileRecord>());

	isViewed(path: string, tab: GitDiffTab, signature: string | null): boolean {
		if (!signature) return false;
		return this.viewedByKey.get(this.key(path, tab))?.signature === signature;
	}

	setViewed(path: string, tab: GitDiffTab, signature: string | null, viewed: boolean): void {
		const key = this.key(path, tab);
		const next = new Map(this.viewedByKey);
		if (viewed && signature) {
			next.set(key, { path, tab, signature, viewedAt: new Date().toISOString() });
		} else {
			next.delete(key);
		}
		this.viewedByKey = next;
	}

	toggleViewed(path: string, tab: GitDiffTab, signature: string | null): boolean {
		if (!signature) {
			this.setViewed(path, tab, null, false);
			return false;
		}
		const nextViewed = !this.isViewed(path, tab, signature);
		this.setViewed(path, tab, signature, nextViewed);
		return nextViewed;
	}

	pruneToPaths(paths: Set<string>): void {
		const next = new Map<string, ViewedFileRecord>();
		for (const [key, record] of this.viewedByKey) {
			if (paths.has(record.path)) next.set(key, record);
		}
		this.viewedByKey = next;
	}

	reset(): void {
		this.hideViewed = false;
		this.showGenerated = false;
		this.viewedByKey = new Map();
	}

	signatureForNode(
		path: string,
		tab: GitDiffTab,
		node: GitTreeNode | undefined,
		reviewData: GitFileReviewData | null | undefined,
	): string | null {
		if (!reviewData || reviewData.path !== path || reviewData.mode !== (tab === 'staged' ? 'staged' : 'working')) {
			return null;
		}
		if (reviewData.isBinary || reviewData.truncated) return null;

		const facet = tab === 'staged' ? node?.stagedFacet : node?.unstagedFacet;
		return [
			tab,
			path,
			node?.indexStatus ?? '',
			node?.workTreeStatus ?? '',
			node?.changeKind ?? '',
			node?.category ?? '',
			node?.stagedFacet?.status ?? '',
			node?.unstagedFacet?.status ?? '',
			facet?.stats.additions ?? '',
			facet?.stats.deletions ?? '',
			reviewData.rows
				.map((row) => [
					row.kind,
					row.beforeLine ?? '',
					row.afterLine ?? '',
					row.diffLineIndex,
					row.text,
				].join(':'))
				.join('\x1f'),
		].join('|');
	}

	private key(path: string, tab: GitDiffTab): string {
		return `${tab}|${path}`;
	}
}
