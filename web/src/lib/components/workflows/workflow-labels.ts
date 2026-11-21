import * as m from '$lib/paraglide/messages.js';
import type { WorkflowStep } from '$shared/workflow-definition';
import type {
	WorkflowAttempt,
	WorkflowInstanceStatus,
	WorkflowRunStatus,
} from '$shared/workflow-runs';

export function workflowStepKindLabel(kind: WorkflowStep['kind']): string {
	switch (kind) {
		case 'agent':
			return m.workflow_studio_agent();
		case 'command':
			return m.workflow_studio_command();
		case 'decision':
			return m.workflow_studio_decision();
	}
}

export function workflowStatusLabel(
	status: WorkflowRunStatus | WorkflowInstanceStatus | WorkflowAttempt['status'],
): string {
	switch (status) {
		case 'running':
			return m.workflow_studio_running();
		case 'waiting':
			return m.workflow_studio_waiting();
		case 'attention':
			return m.workflow_studio_attention();
		case 'succeeded':
			return m.workflow_studio_succeeded();
		case 'archived':
			return m.workflow_studio_archived();
		case 'ready':
			return m.workflow_studio_ready();
		case 'waiting-executor':
			return m.workflow_studio_waiting_executor();
		case 'awaiting-decision':
			return m.workflow_studio_awaiting_decision();
		case 'failed':
			return m.workflow_studio_failed();
		case 'unknown':
			return m.workflow_studio_unknown();
		case 'blocked':
			return m.workflow_studio_blocked();
		case 'unavailable':
			return m.common_unavailable();
	}
}
