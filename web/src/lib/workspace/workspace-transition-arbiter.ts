import { reduceWorkspaceLayout } from '$lib/stores/workspace-layout.svelte.js';
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
	#tail: Promise<void> = Promise.resolve();

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
		let resolveResult: (value: boolean) => void;
		const result = new Promise<boolean>((resolve) => {
			resolveResult = resolve;
		});
		let failureNotified = false;
		const notifyFailure = () => {
			if (failureNotified) return;
			failureNotified = true;
			hooks.publishFailed?.();
		};
		const turn = this.#tail.then(() => {
			try {
				while (true) {
					const revision = this.layout.revision;
					const snapshot = this.layout.snapshot;
					const mutations = typeof plan === 'function' ? plan(snapshot) : plan;
					if (mutations.length === 0) {
						hooks.beforePublish?.(snapshot, snapshot);
						resolveResult(true);
						return;
					}
					const next = reduceWorkspaceLayout(snapshot, mutations);
					hooks.beforePublish?.(next, snapshot);
					const published = this.commitPort.publish(revision, next);
					if (published) {
						resolveResult(true);
						return;
					}
					notifyFailure();
					if (!options.retryPublishFailure) {
						resolveResult(false);
						return;
					}
					failureNotified = false;
				}
			} catch {
				notifyFailure();
				resolveResult(false);
			}
		});
		this.#tail = turn.then(
			() => undefined,
			() => undefined,
		);
		void turn.catch(() => {
			notifyFailure();
			resolveResult(false);
		});
		return result;
	}
}
