import { reduceWorkspaceLayout } from './workspace-layout.svelte.js';
import { SerialQueue } from '$lib/utils/serial-queue.js';
import type {
	WorkspaceLayoutCommitPort,
	WorkspaceLayoutMutation,
	WorkspaceLayoutReader,
	WorkspaceLayoutSnapshot,
} from './surface-types.js';

export type WorkspaceMutationPlan =
	| readonly WorkspaceLayoutMutation[]
	| ((snapshot: WorkspaceLayoutSnapshot) => readonly WorkspaceLayoutMutation[]);

export class WorkspaceTransitionArbiter {
	#queue = new SerialQueue();

	constructor(
		readonly layout: WorkspaceLayoutReader,
		private readonly commitPort: WorkspaceLayoutCommitPort,
	) {}

	commit(
		plan: WorkspaceMutationPlan,
		hooks: {
			beforePublish?: (next: WorkspaceLayoutSnapshot, base: WorkspaceLayoutSnapshot) => void;
			afterPublish?: (next: WorkspaceLayoutSnapshot) => void;
			publishFailed?: () => void;
		} = {},
		options: { retryPublishFailure?: boolean } = {},
	): Promise<boolean> {
		let failureNotified = false;
		const notifyFailure = () => {
			if (failureNotified) return;
			failureNotified = true;
			hooks.publishFailed?.();
		};
		return this.#queue.enqueue(() => {
			let publishedSnapshot: WorkspaceLayoutSnapshot;
			try {
				while (true) {
					const revision = this.layout.revision;
					const snapshot = this.layout.snapshot;
					const mutations = typeof plan === 'function' ? plan(snapshot) : plan;
					const hasMutations = mutations.length > 0;
					const next = hasMutations ? reduceWorkspaceLayout(snapshot, mutations) : snapshot;
					hooks.beforePublish?.(next, snapshot);
					if (!hasMutations || this.commitPort.publish(revision, next)) {
						publishedSnapshot = next;
						break;
					}
					notifyFailure();
					if (!options.retryPublishFailure) {
						return false;
					}
					failureNotified = false;
				}
			} catch (error) {
				try {
					notifyFailure();
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], 'Workspace transition failed', {
						cause: rollbackError,
					});
				}
				throw error;
			}
			// Success observers run outside rollback handling: the layout is already committed.
			hooks.afterPublish?.(publishedSnapshot);
			return true;
		});
	}
}
