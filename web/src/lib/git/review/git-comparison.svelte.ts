import {
	getGitComparisonFreshness,
	getGitComparisonFileBodies,
	getGitComparisonSnapshot,
	type GitComparisonMode,
	type GitComparisonSnapshotReady,
} from '$lib/api/git-comparison.js';
import { GitDiffDocumentController } from '$lib/git/review/git-diff-document.svelte.js';
import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
import * as m from '$lib/paraglide/messages.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';

export type GitComparisonToKind = 'revision' | 'working-tree';
export type GitComparisonSelectionSlot = 'from' | 'to';
export const GIT_EMPTY_TREE_REVISION = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitComparisonDialogDefaults {
	fromRevision: string;
	toKind: GitComparisonToKind;
	toRevision?: string;
	mode?: GitComparisonMode;
}

interface GitComparisonCommitCandidate {
	hash: string;
	parents: string[];
}

export function recentCommitComparisonDefaults(
	commits: GitComparisonCommitCandidate[],
): GitComparisonDialogDefaults {
	const toCommit = commits[0];
	return {
		fromRevision: commits[1]?.hash ?? toCommit?.parents[0] ?? GIT_EMPTY_TREE_REVISION,
		toKind: 'revision',
		toRevision: toCommit?.hash ?? 'HEAD',
	};
}

export interface GitComparisonDisplayOptions {
	diffMode: DiffMode;
	contextLines: number;
}

export class GitComparisonController {
	readonly document = new GitDiffDocumentController();
	dialogOpen = $state(false);
	fromRevision = $state('HEAD');
	toKind = $state<GitComparisonToKind>('working-tree');
	toRevision = $state('HEAD');
	mode = $state<GitComparisonMode>('direct');
	snapshot = $state<GitComparisonSnapshotReady | null>(null);
	isLoading = $state(false);
	error = $state<string | null>(null);
	bodyError = $state<string | null>(null);
	errorStatus = $state<'not-found' | 'no-merge-base' | 'working-tree-changing' | null>(null);
	errorEndpoint = $state<'from' | 'to' | null>(null);
	staleMessage = $state<string | null>(null);
	historySelectionActive = $state(false);
	historySelectionSlot = $state<GitComparisonSelectionSlot>('from');
	historySelectionFrom = $state<string | null>(null);
	historySelectionTo = $state<string | null>(null);

	get documentError(): string | null {
		return this.bodyError ?? (this.dialogOpen ? null : this.error);
	}

	private snapshotAbort: AbortController | null = null;
	private generation = 0;
	private diffMode: DiffMode = 'unified';
	private contextLines = 5;
	private loadedContextLines = 5;
	private activeProjectPath: string | null = null;

	openDialog(
		defaults: GitComparisonDialogDefaults,
		displayOptions?: GitComparisonDisplayOptions,
	): void {
		if (displayOptions) {
			this.diffMode = displayOptions.diffMode;
			this.contextLines = displayOptions.contextLines;
			if (!this.snapshot) this.loadedContextLines = displayOptions.contextLines;
			this.document.setDisplayOptions(
				displayOptions.diffMode,
				this.snapshot ? this.loadedContextLines : displayOptions.contextLines,
			);
		}
		this.fromRevision = defaults.fromRevision;
		this.toKind = defaults.toKind;
		this.toRevision = defaults.toRevision ?? 'HEAD';
		this.mode = defaults.toKind === 'working-tree' ? 'direct' : (defaults.mode ?? 'direct');
		this.clearError();
		this.dialogOpen = true;
	}

	editComparison(): void {
		this.restoreInputsFromSnapshot();
		this.clearError();
		this.dialogOpen = true;
	}

	closeDialog(): void {
		if (this.isLoading) {
			this.snapshotAbort?.abort();
			this.snapshotAbort = null;
			this.generation += 1;
			this.isLoading = false;
		}
		this.restoreInputsFromSnapshot();
		this.dialogOpen = false;
		this.clearError();
	}

	setToKind(kind: GitComparisonToKind): void {
		this.toKind = kind;
		if (kind === 'working-tree') this.mode = 'direct';
	}

	swapRevisions(): void {
		if (this.toKind !== 'revision') return;
		const from = this.fromRevision;
		this.fromRevision = this.toRevision;
		this.toRevision = from;
	}

	beginHistorySelection(): void {
		this.historySelectionActive = true;
		this.historySelectionSlot = 'from';
		this.historySelectionFrom = null;
		this.historySelectionTo = null;
	}

	cancelHistorySelection(): void {
		this.historySelectionActive = false;
		this.historySelectionSlot = 'from';
		this.historySelectionFrom = null;
		this.historySelectionTo = null;
	}

	setHistorySelectionSlot(slot: GitComparisonSelectionSlot): void {
		if (!this.historySelectionActive) return;
		this.historySelectionSlot = slot;
	}

	selectHistoryCommit(hash: string): void {
		if (!this.historySelectionActive) return;
		if (this.historySelectionSlot === 'from') {
			this.historySelectionFrom = hash;
			this.historySelectionSlot = 'to';
			return;
		}
		this.historySelectionTo = hash;
	}

	takeSelectedHistoryRange(): GitComparisonDialogDefaults | null {
		if (!this.historySelectionFrom || !this.historySelectionTo) return null;
		const defaults: GitComparisonDialogDefaults = {
			fromRevision: this.historySelectionFrom,
			toKind: 'revision',
			toRevision: this.historySelectionTo,
		};
		this.cancelHistorySelection();
		return defaults;
	}

	setDisplayOptions(projectPath: string, diffMode: DiffMode, contextLines: number): void {
		const contextChanged = this.contextLines !== contextLines;
		if (contextChanged && this.document.commentComposer.open) {
			this.document.markContextChangeBlocked();
			return;
		}
		this.diffMode = diffMode;
		this.contextLines = contextLines;
		this.document.setDisplayOptions(
			diffMode,
			this.snapshot ? this.loadedContextLines : contextLines,
		);
		if (!contextChanged || !this.snapshot) return;
		if (this.snapshot.to.kind === 'working-tree') {
			if (contextLines !== this.loadedContextLines) {
				if (!this.document.isStale) {
					this.staleMessage = m.git_compare_context_refresh_required();
				}
			} else if (!this.document.isStale) {
				this.staleMessage = null;
			}
			return;
		}
		void this.refresh(projectPath);
	}

	async compare(projectPath: string): Promise<boolean> {
		this.clearError();
		const fromRevision = this.fromRevision.trim();
		const toRevision = this.toRevision.trim();
		if (!fromRevision || (this.toKind === 'revision' && !toRevision)) {
			this.error = m.git_compare_choose_endpoints();
			return false;
		}

		this.snapshotAbort?.abort();
		const controller = new AbortController();
		const generation = ++this.generation;
		this.activeProjectPath = projectPath;
		this.snapshotAbort = controller;
		this.isLoading = true;
		const to =
			this.toKind === 'working-tree'
				? ({ kind: 'working-tree' } as const)
				: ({ kind: 'revision', revision: toRevision } as const);
		const mode = this.toKind === 'working-tree' ? 'direct' : this.mode;
		const requestContextLines = this.contextLines;

		try {
			const result = await getGitComparisonSnapshot(
				projectPath,
				{ kind: 'revision', revision: fromRevision },
				to,
				mode,
				{ context: requestContextLines, bodyCandidateCount: 8, signal: controller.signal },
			);
			if (!this.isCurrent(generation, projectPath, controller.signal)) return false;
			if (result.status !== 'ready') {
				this.error = result.message;
				this.errorStatus = result.status;
				this.errorEndpoint = result.status === 'not-found' ? result.endpoint : null;
				return false;
			}

			this.snapshot = result;
			this.bodyError = null;
			this.loadedContextLines = requestContextLines;
			this.staleMessage = null;
			this.dialogOpen = false;
			this.document.open(result, {
				contextLines: requestContextLines,
				diffMode: this.diffMode,
				commentSource: {
					kind: 'comparison',
					fromLabel: result.from.label,
					fromIdentity: result.from.shortHash,
					toLabel: result.to.label,
					toIdentity:
						result.to.kind === 'revision' ? result.to.shortHash : result.to.shortFingerprint,
					mode: result.mode,
					...(result.mergeBaseHash ? { mergeBaseHash: result.mergeBaseHash } : {}),
				},
				loadBodies: (_snapshot, files, signal) =>
					getGitComparisonFileBodies(
						projectPath,
						result.documentId,
						result.effectiveFromHash,
						result.to.kind === 'revision'
							? { kind: 'revision', hash: result.to.hash }
							: { kind: 'working-tree', fingerprint: result.to.fingerprint },
						files,
						{ context: requestContextLines, signal },
					),
				onError: (detail) => {
					this.bodyError = m.git_compare_load_rows_failed({ detail });
				},
				onBodyLoadSuccess: () => {
					this.bodyError = null;
				},
				onStale: (message) => {
					this.staleMessage = message;
				},
			});
			return true;
		} catch (error) {
			if (isAbortError(error) || !this.isCurrent(generation, projectPath, controller.signal)) {
				return false;
			}
			this.error = error instanceof Error ? error.message : String(error);
			this.errorStatus = null;
			this.errorEndpoint = null;
			return false;
		} finally {
			if (this.isCurrent(generation, projectPath, controller.signal)) {
				this.isLoading = false;
				this.snapshotAbort = null;
			}
		}
	}

	async refresh(projectPath: string): Promise<void> {
		this.restoreInputsFromSnapshot();
		await this.compare(projectPath);
	}

	async checkFreshness(projectPath: string): Promise<void> {
		const snapshot = this.snapshot;
		if (!snapshot || this.activeProjectPath !== projectPath || this.document.isStale) return;
		if (
			snapshot.to.kind === 'revision' &&
			snapshot.from.requestedRevision === snapshot.from.hash &&
			snapshot.to.requestedRevision === snapshot.to.hash
		)
			return;
		try {
			const result = await getGitComparisonFreshness(
				snapshot.repoRoot,
				{
					kind: 'revision',
					revision: snapshot.from.requestedRevision,
					hash: snapshot.from.hash,
				},
				snapshot.to.kind === 'revision'
					? {
							kind: 'revision',
							revision: snapshot.to.requestedRevision,
							hash: snapshot.to.hash,
						}
					: { kind: 'working-tree', fingerprint: snapshot.to.fingerprint },
			);
			if (this.snapshot?.documentId !== snapshot.documentId) return;
			if (result.status === 'not-found') {
				this.document.markStale(m.git_compare_revision_unavailable());
				return;
			}
			if (result.changedEndpoints.length === 0) return;
			const onlyWorkingTreeChanged =
				snapshot.to.kind === 'working-tree' &&
				result.changedEndpoints.length === 1 &&
				result.changedEndpoints[0] === 'to';
			this.document.markStale(
				onlyWorkingTreeChanged
					? m.git_compare_working_tree_changed()
					: m.git_compare_revision_changed(),
			);
		} catch {
			// Freshness polling remains quiet until the next scheduled check.
		}
	}

	focusFile(filePath: string): void {
		this.document.focusFile(filePath);
	}

	setVisibleRows(rows: GitVirtualReviewRow[]): void {
		this.document.setVisibleRows(rows);
	}

	setFileFilter(value: string): void {
		this.document.setFileFilter(value);
	}

	reset(): void {
		this.snapshotAbort?.abort();
		this.snapshotAbort = null;
		this.generation += 1;
		this.activeProjectPath = null;
		this.dialogOpen = false;
		this.snapshot = null;
		this.isLoading = false;
		this.error = null;
		this.bodyError = null;
		this.errorStatus = null;
		this.errorEndpoint = null;
		this.staleMessage = null;
		this.loadedContextLines = this.contextLines;
		this.cancelHistorySelection();
		this.document.clear();
	}

	dismissDocumentError(): void {
		this.bodyError = null;
		if (!this.dialogOpen) this.clearError();
	}

	private isCurrent(generation: number, projectPath: string, signal: AbortSignal): boolean {
		return (
			!signal.aborted && generation === this.generation && this.activeProjectPath === projectPath
		);
	}

	private clearError(): void {
		this.error = null;
		this.errorStatus = null;
		this.errorEndpoint = null;
	}

	private restoreInputsFromSnapshot(): void {
		const snapshot = this.snapshot;
		if (!snapshot) return;
		this.fromRevision = snapshot.from.requestedRevision;
		this.toKind = snapshot.to.kind === 'working-tree' ? 'working-tree' : 'revision';
		if (snapshot.to.kind === 'revision') this.toRevision = snapshot.to.requestedRevision;
		this.mode = snapshot.mode;
	}
}
