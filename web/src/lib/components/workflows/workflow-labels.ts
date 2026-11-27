import * as m from '$lib/paraglide/messages.js';
import type { WorkflowStep } from '$shared/workflow-definition';
import type { WorkflowGraphNodeTone } from '$lib/workflows/definition/workflow-graph';
import type {
	WorkflowAttempt,
	WorkflowInstanceStatus,
	WorkflowRunStatus,
} from '$shared/workflow-runs';

export function workflowToneCardClass(tone: WorkflowGraphNodeTone | undefined): string {
	switch (tone) {
		case 'success':
			return 'border-status-success-border bg-status-success';
		case 'error':
			return 'border-status-error-border bg-status-error';
		case 'warning':
			return 'border-status-warning-border bg-status-warning';
		case 'info':
			return 'border-status-info-border bg-status-info';
		case 'neutral':
			return 'border-status-neutral-border bg-status-neutral';
		default:
			return 'border-border bg-card';
	}
}

export function workflowToneTextClass(tone: WorkflowGraphNodeTone | undefined): string {
	switch (tone) {
		case 'success':
			return 'text-status-success-foreground';
		case 'error':
			return 'text-status-error-foreground';
		case 'warning':
			return 'text-status-warning-foreground';
		case 'info':
			return 'text-status-info-foreground';
		default:
			return 'text-muted-foreground';
	}
}

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
