import { isWorkflowName } from '$shared/workflow-definition';

export function isNewWorkflowField(name: string, existing: object): boolean {
	return isWorkflowName(name) && !Object.hasOwn(existing, name);
}
