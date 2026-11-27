import type { WorkflowLocation } from '$shared/workflow-runs';
import { validateStart } from '$lib/api/chats';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import * as m from '$lib/paraglide/messages.js';

export async function validateWorkflowLocation(
	location: WorkflowLocation,
	executors: ExecutorsStore,
): Promise<string | null> {
	const { executorId, projectPath } = location;
	if (executors.hasSnapshot && executorId !== 'local' && !executors.get(executorId))
		return m.workflow_studio_unknown_executor({ executor: executorId });
	if (!executors.isReady(executorId)) return null;
	const result = await validateStart(projectPath, { executorId });
	return result.valid
		? null
		: m.workflow_studio_invalid_folder({
				path: projectPath,
				executor: executors.label(executorId),
			});
}
