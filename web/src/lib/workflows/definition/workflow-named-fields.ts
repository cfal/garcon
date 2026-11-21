import type { WorkflowValueType } from '$shared/workflow-definition';

export const WORKFLOW_VALUE_TYPES = [
	'string',
	'number',
	'boolean',
	'json',
] as const satisfies readonly WorkflowValueType[];

export function isNewWorkflowField(name: string, existing: object): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(name) && !Object.hasOwn(existing, name);
}
