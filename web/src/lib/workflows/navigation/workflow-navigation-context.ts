import { createContext } from 'svelte';
import type { WorkflowSurfaceDescriptor } from '$lib/workspace/surface-types';

export const [getWorkflowNavigation, setWorkflowNavigation] = createContext<{
	openRun(runId: string, source: WorkflowSurfaceDescriptor): void;
	openNewWorkflow(source: WorkflowSurfaceDescriptor): void;
	openChat(
		chatId: string,
		source: Extract<WorkflowSurfaceDescriptor, { type: 'workflow-run' }>,
	): void;
}>();
