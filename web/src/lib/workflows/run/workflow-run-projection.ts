import type { WorkflowGraphEdge } from '../definition/workflow-graph';
import type {
	WorkflowInstanceStatus,
	WorkflowRunDetail,
	WorkflowRunStep,
	WorkflowSignalOccurrence,
	WorkflowStepInstance,
} from '$shared/workflow-runs';

export const WORKFLOW_INSTANCE_STATUSES = [
	'ready',
	'running',
	'waiting-executor',
	'awaiting-decision',
	'succeeded',
	'failed',
	'unknown',
	'blocked',
] as const satisfies readonly WorkflowInstanceStatus[];

export function workflowRunFinished(run: WorkflowRunDetail): boolean {
	return run.status === 'succeeded' || run.status === 'archived';
}

export function workflowRunHasLiveAttempt(run: WorkflowRunDetail): boolean {
	return run.steps.some(({ instances }) =>
		instances.some(({ attempts }) => attempts.some(({ status }) => status === 'running')),
	);
}

export function workflowInstanceCanStop(status: WorkflowInstanceStatus): boolean {
	return status === 'running' || status === 'ready' || status === 'waiting-executor';
}

export function workflowRunCanStop(run: WorkflowRunDetail): boolean {
	return (
		!workflowRunFinished(run) &&
		(workflowRunHasLiveAttempt(run) || run.status === 'running' || run.status === 'waiting')
	);
}

export function matchingWorkflowInstances(
	instances: readonly WorkflowStepInstance[],
	query: string,
	status: WorkflowInstanceStatus | '',
): readonly WorkflowStepInstance[] {
	const match = query.trim().toLowerCase();
	return instances.filter(
		(instance) =>
			(!status || instance.status === status) &&
			(!match || (instance.key ?? instance.id).toLowerCase().includes(match)),
	);
}

export function stepEvidence(
	step: WorkflowRunStep,
	instance: WorkflowStepInstance | null,
	signals: readonly WorkflowSignalOccurrence[],
): readonly WorkflowSignalOccurrence[] {
	if (!instance) return signals.filter((signal) => signal.ref.stepId === step.step.id);
	const consumed =
		instance.trigger.kind === 'signal'
			? instance.trigger.signalId
			: instance.trigger.kind === 'join'
				? instance.trigger.closeSignalId
				: null;
	return signals.filter((signal) => signal.id === consumed || signal.instanceId === instance.id);
}

export function manualWorkflowEdges(run: WorkflowRunDetail): WorkflowGraphEdge[] {
	const signals = new Map(run.signals.map((signal) => [signal.id, signal]));
	return run.amendments.flatMap((amendment) => {
		if (amendment.kind !== 'add-step' || !amendment.evidenceSignalId) return [];
		const signal = signals.get(amendment.evidenceSignalId);
		return signal
			? [{ source: signal.ref.stepId, target: amendment.stepId, label: signal.ref.signal }]
			: [];
	});
}
