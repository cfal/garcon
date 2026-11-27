import {
	WORKFLOW_TURN_COMPLETED,
	type WorkflowBinding,
	type WorkflowSignalDefinition,
	type WorkflowStep,
} from '$shared/workflow-definition';
import type { JsonObject } from '$shared/json';

export interface WorkflowSignalOption {
	value: string;
	label: string;
	delivery: WorkflowSignalDefinition['delivery'];
	payload: WorkflowSignalDefinition['payload'];
	fields: readonly string[];
}

export function workflowSignalSubscription(
	option: WorkflowSignalOption,
	maxConcurrency = 1,
): JsonObject {
	if (option.delivery === 'many') return { kind: 'each', signal: option.value, maxConcurrency };
	return { kind: 'once', signal: option.value };
}

export function workflowBindingSource(binding: WorkflowBinding): string {
	switch (binding.kind) {
		case 'input':
			return `inputs.${binding.input}`;
		case 'all':
			return `all.${binding.stepId}`;
		case 'signal':
			return binding.field === undefined ? 'signal' : `signal.${binding.field}`;
	}
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
