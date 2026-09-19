import type { ProjectResolutionStore } from './project-resolution-store.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { effectiveNodeId } from '$shared/execution-nodes';

export type ProjectResolver = Pick<ProjectResolutionStore, 'retain'>;

interface ProjectPathResolutionDeps {
	workspaceContext: Pick<WorkspaceContextStore, 'currentTarget'>;
	projectResolution: ProjectResolver;
}

export async function resolveProjectPath(deps: ProjectPathResolutionDeps): Promise<string | null> {
	const target = deps.workspaceContext.currentTarget;
	if (!target) return null;
	if (effectiveNodeId(target.nodeId) !== 'local') throw new Error('Terminals are unavailable on remote execution nodes.');
	const lease = deps.projectResolution.retain(target);
	try {
		await lease.resolve();
		const snapshot = lease.snapshot;
		if (snapshot.kind === 'available') return target.projectPath;
		if (snapshot.kind === 'request-failed') throw new Error(snapshot.message);
		throw new Error(m.workspace_project_unavailable());
	} finally {
		lease.release();
	}
}
