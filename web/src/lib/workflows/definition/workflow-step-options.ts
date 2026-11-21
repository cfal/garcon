import {
	WORKFLOW_TURN_COMPLETED,
	type WorkflowSignalDefinition,
	type WorkflowStep,
} from '$shared/workflow-definition';

export interface WorkflowSignalOption {
	value: string;
	label: string;
	delivery: WorkflowSignalDefinition['delivery'];
	payload: WorkflowSignalDefinition['payload'];
	fields: readonly string[];
}

export function workflowSignals(steps: readonly WorkflowStep[]): WorkflowSignalOption[] {
	return steps.flatMap((step): WorkflowSignalOption[] => {
		const option = (
			signal: string,
			delivery: WorkflowSignalOption['delivery'],
			payload: WorkflowSignalOption['payload'],
			fields: readonly string[] = [],
		): WorkflowSignalOption => ({
			value: `${step.id}.${signal}`,
			label: `${step.name ?? step.id} / ${signal}`,
			delivery,
			payload,
			fields,
		});
		if (step.kind === 'decision') {
			return Object.keys(step.choices).map((signal) => option(signal, 'once', 'none'));
		}
		return [
			option(WORKFLOW_TURN_COMPLETED, 'once', 'text'),
			...Object.entries(step.kind === 'agent' ? (step.signals ?? {}) : {}).map(([signal, shape]) =>
				option(
					signal,
					shape.delivery,
					shape.payload,
					shape.payload === 'json' ? Object.keys(shape.fields ?? {}) : [],
				),
			),
		];
	});
}

export function nextWorkflowStepId(steps: readonly WorkflowStep[], base: string): string {
	const ids = new Set(steps.map(({ id }) => id));
	if (!ids.has(base)) return base;
	const prefix = base.slice(0, 118);
	let suffix = 2;
	while (ids.has(`${prefix}-${suffix}`)) suffix++;
	return `${prefix}-${suffix}`;
}
