import { getGitWorkingTreeFingerprint } from '$lib/api/git.js';
import type { GitProjectTarget } from '$lib/api/git-client.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';

export class GitWorkbenchFreshnessTracker {
	loadedFingerprint = $state<string | null>(null);
	latestFingerprint = $state<string | null>(null);
	isStale = $state(false);
	error = $state<string | null>(null);
	private activeCheck: AbortController | null = null;

	async check(project: GitProjectTarget, isCurrent: () => boolean): Promise<void> {
		if (!this.loadedFingerprint || this.isStale || this.activeCheck) return;
		const controller = new AbortController();
		this.activeCheck = controller;
		try {
			const result = await getGitWorkingTreeFingerprint(project, { signal: controller.signal });
			if (controller.signal.aborted || !isCurrent()) return;
			if (result.status !== 'ready') {
				this.error = result.status === 'unknown' ? result.message : null;
				return;
			}
			this.error = null;
			this.latestFingerprint = result.fingerprint;
			this.isStale = result.fingerprint !== this.loadedFingerprint;
		} catch (error) {
			if (isAbortError(error) || controller.signal.aborted || !isCurrent()) return;
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.activeCheck === controller) this.activeCheck = null;
		}
	}

	abort(): void {
		this.activeCheck?.abort();
		this.activeCheck = null;
	}

	applyFingerprint(fingerprint: string | null): void {
		this.loadedFingerprint = fingerprint;
		this.latestFingerprint = fingerprint;
		this.isStale = false;
		this.error = null;
	}

	reset(): void {
		this.abort();
		this.applyFingerprint(null);
	}
}
