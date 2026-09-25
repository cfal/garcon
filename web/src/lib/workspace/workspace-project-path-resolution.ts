import type { ProjectResolutionStore } from './project-resolution-store.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { effectiveExecutorId } from '$shared/executors';

export type ProjectResolver = Pick<ProjectResolutionStore, 'retain'>;

interface ProjectPathResolutionDeps {
	workspaceContext: Pick<WorkspaceContextStore, 'currentTarget'>;
	projectResolution: ProjectResolver;
}

export interface TerminalCreationTarget {
	executorId: string;
	projectPath: string | null;
}

export async function resolveProjectPath(
	deps: ProjectPathResolutionDeps,
	executorId?: string,
): Promise<TerminalCreationTarget> {
	const target = deps.workspaceContext.currentTarget;
	const selectedExecutor = executorId ?? effectiveExecutorId(target?.executorId);
	if (!target || selectedExecutor !== effectiveExecutorId(target.executorId))
		return { executorId: selectedExecutor, projectPath: null };
	const lease = deps.projectResolution.retain(target);
	try {
		await lease.resolve();
		const snapshot = lease.snapshot;
		if (snapshot.kind === 'available')
			return { executorId: selectedExecutor, projectPath: target.projectPath };
		if (snapshot.kind === 'request-failed') throw new Error(snapshot.message);
		throw new Error(m.workspace_project_unavailable());
	} finally {
		lease.release();
	}
}
