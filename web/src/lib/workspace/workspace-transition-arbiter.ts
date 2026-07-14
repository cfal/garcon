import { reduceWorkspaceLayout } from '$lib/stores/workspace-layout.svelte.js';
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
			try {
				while (true) {
					const revision = this.layout.revision;
					const snapshot = this.layout.snapshot;
					const mutations = typeof plan === 'function' ? plan(snapshot) : plan;
					if (mutations.length === 0) {
						hooks.beforePublish?.(snapshot, snapshot);
						return true;
					}
					const next = reduceWorkspaceLayout(snapshot, mutations);
					hooks.beforePublish?.(next, snapshot);
					const published = this.commitPort.publish(revision, next);
					if (published) {
						return true;
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
		});
	}
}
