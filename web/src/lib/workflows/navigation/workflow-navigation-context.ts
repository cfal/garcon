import { getContext, setContext } from 'svelte';
import type { SidebarWorkflowRun } from '$lib/sidebar/display/sidebar-virtual-chat-list';
import type { WorkflowSurfaceDescriptor } from '$lib/workspace/surface-types';

export interface WorkflowNavigation {
	openRun(runId: string, source: WorkflowSurfaceDescriptor): void;
	openRunById(runId: string, fromSurfaceId?: string): void;
	openNewWorkflow(source: WorkflowSurfaceDescriptor): void;
	openChat(
		chatId: string,
		source: Extract<WorkflowSurfaceDescriptor, { type: 'workflow-run' }>,
	): void;
	runForChat(chatId: string): SidebarWorkflowRun | undefined;
	runName(runId: string): string | undefined;
	rememberRunName(runId: string, name: string): void;
}

const WORKFLOW_NAVIGATION_KEY = Symbol('workflow-navigation');

export function setWorkflowNavigation(navigation: WorkflowNavigation): WorkflowNavigation {
	return setContext(WORKFLOW_NAVIGATION_KEY, navigation);
}

export function getWorkflowNavigation(): WorkflowNavigation {
	const navigation = getOptionalWorkflowNavigation();
	if (!navigation) throw new Error('WorkflowNavigation context is not provided.');
	return navigation;
}

export function getOptionalWorkflowNavigation(): WorkflowNavigation | null {
	return getContext<WorkflowNavigation | undefined>(WORKFLOW_NAVIGATION_KEY) ?? null;
}
