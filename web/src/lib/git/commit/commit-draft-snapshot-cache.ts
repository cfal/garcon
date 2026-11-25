import type { GitTreeNode } from '$lib/api/git.js';
import type { QuickCommitPathIntent } from './commit-stage-queue.js';

const COLD_COMMIT_SNAPSHOT_LIMIT = 8;

interface CommitTargetSnapshot {
	tree: GitTreeNode[];
	intents: Record<string, QuickCommitPathIntent>;
	message: string;
}

export class CommitDraftSnapshotCache {
	private entries = new Map<string, CommitTargetSnapshot>();

	save(key: string, snapshot: CommitTargetSnapshot, activeKey: string | null): void {
		this.entries.delete(key);
		this.entries.set(key, snapshot);
		let retained = 0;
		for (const [key, snapshot] of [...this.entries].reverse()) {
			if (key === activeKey || ++retained <= COLD_COMMIT_SNAPSHOT_LIMIT) continue;
			this.dropTree(key, snapshot);
		}
	}

	restore(key: string): CommitTargetSnapshot | null {
		const snapshot = this.entries.get(key);
		if (!snapshot) return null;
		this.entries.delete(key);
		this.entries.set(key, snapshot);
		return snapshot;
	}

	countDrafts(activeKey: string | null): number {
		let count = 0;
		for (const [key, snapshot] of this.entries) {
			if (key !== activeKey && snapshot.message.trim()) count += 1;
		}
		return count;
	}

	discardDrafts(): void {
		for (const [key, snapshot] of this.entries) {
			this.entries.set(key, { ...snapshot, message: '' });
		}
	}

	pruneExecutors(executorIds: ReadonlySet<string>): void {
		for (const [key, snapshot] of this.entries) {
			if (!executorIds.has(JSON.parse(key)[0])) this.dropTree(key, snapshot);
		}
	}

	clear(): void {
		this.entries.clear();
	}

	private dropTree(key: string, snapshot: CommitTargetSnapshot): void {
		if (snapshot.message.trim()) this.entries.set(key, { ...snapshot, tree: [], intents: {} });
		else this.entries.delete(key);
	}
}
