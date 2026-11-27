import { isRecord, stableJsonStringify, type JsonValue } from '$shared/json';
import type { WorkflowDefinitionEdit, WorkflowFieldPath } from '$shared/workflow-definition';

export function workflowFieldEdits(
	path: WorkflowFieldPath,
	before: JsonValue | undefined,
	after: JsonValue | undefined,
): WorkflowDefinitionEdit[] {
	if (before === after) return [];
	if (after === undefined) return [{ kind: 'delete', path }];
	if (isRecord(before) && isRecord(after)) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		return [...keys].flatMap((key) =>
			workflowFieldEdits(
				[...path, key],
				Object.hasOwn(before, key) ? before[key] : undefined,
				Object.hasOwn(after, key) ? after[key] : undefined,
			),
		);
	}
	if (before !== undefined && stableJsonStringify(before) === stableJsonStringify(after)) return [];
	return [{ kind: 'upsert', path, value: after }];
}
