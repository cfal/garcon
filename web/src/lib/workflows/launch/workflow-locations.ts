import type { WorkflowStep } from '$shared/workflow-definition';
import type { WorkflowExecutionContext, WorkflowLocation } from '$shared/workflow-runs';

export interface WorkflowLaunchContext {
	executorId: string;
	cwd: string;
}

export function workflowLocations(
	steps: readonly WorkflowStep[],
	executorId: string,
	paths: Readonly<Record<string, string>>,
): {
	requiredFolders: readonly string[];
	missingFolders: readonly string[];
	locations: readonly { step: WorkflowStep; location: WorkflowLocation }[];
	executionContext: WorkflowExecutionContext;
} {
	const requiredFolders = new Set<string>();
	const locations: { step: WorkflowStep; location: WorkflowLocation }[] = [];
	let needsLaunchExecutor = false;
	let inheritedOverride: string | undefined;
	const folder = (id: string) => (Object.hasOwn(paths, id) ? paths[id]?.trim() : undefined);

	for (const step of steps) {
		if (step.kind === 'decision') continue;
		const id = step.executorId ?? executorId;
		if (!step.executorId) {
			needsLaunchExecutor = true;
			inheritedOverride ??= step.projectPath;
		}
		if (!step.projectPath) requiredFolders.add(id);
		locations.push({
			step,
			location: { executorId: id, projectPath: step.projectPath ?? folder(id) ?? '' },
		});
	}
	const missingFolders = [...requiredFolders].filter((id) => !folder(id));
	const projectPaths = Object.fromEntries(
		[...requiredFolders].flatMap((id) => (folder(id) ? [[id, folder(id)!]] : [])),
	);
	const defaultPath = folder(executorId) || inheritedOverride;
	return {
		requiredFolders: [...requiredFolders],
		missingFolders,
		locations,
		executionContext: {
			...(needsLaunchExecutor && defaultPath
				? { defaultTarget: { executorId, projectPath: defaultPath } }
				: {}),
			...(Object.keys(projectPaths).length ? { projectPaths } : {}),
		},
	};
}
