import type { ProjectResolutionStore } from './project-resolution-store.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { effectiveNodeId } from '$shared/execution-nodes';

export type ProjectResolver = Pick<ProjectResolutionStore, 'retain'>;

interface ProjectPathResolutionDeps {
	workspaceContext: Pick<WorkspaceContextStore, 'currentTarget'>;
	projectResolution: ProjectResolver;
}

export interface TerminalCreationTarget {
	nodeId: string;
	projectPath: string | null;
}

export async function resolveProjectPath(
	deps: ProjectPathResolutionDeps,
	nodeId?: string,
): Promise<TerminalCreationTarget> {
	const target = deps.workspaceContext.currentTarget;
	const selectedNode = nodeId ?? effectiveNodeId(target?.nodeId);
	if (!target || selectedNode !== effectiveNodeId(target.nodeId))
		return { nodeId: selectedNode, projectPath: null };
	const lease = deps.projectResolution.retain(target);
	try {
		await lease.resolve();
		const snapshot = lease.snapshot;
		if (snapshot.kind === 'available')
			return { nodeId: selectedNode, projectPath: target.projectPath };
		if (snapshot.kind === 'request-failed') throw new Error(snapshot.message);
		throw new Error(m.workspace_project_unavailable());
	} finally {
		lease.release();
	}
}
