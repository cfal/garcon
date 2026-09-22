import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import type { PullRequestsStore } from '../pull-requests-store.svelte.js';

export function bindProject(store: PullRequestsStore, project: WorkspaceProjectState) {
	let current = $state(project);
	let runs = 0;
	const dispose = $effect.root(() => {
		$effect(() => {
			runs++;
			store.setProjectState(current);
		});
	});
	return {
		dispose,
		get runs() {
			return runs;
		},
		setProject(next: WorkspaceProjectState) {
			current = next;
		},
	};
}
