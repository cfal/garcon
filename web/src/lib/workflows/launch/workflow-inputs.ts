import type { JsonObject, JsonValue } from '$shared/json';
import type { WorkflowInput, WorkflowValueType } from '$shared/workflow-definition';

export function workflowInputText(value: JsonValue | undefined, type: WorkflowValueType): string {
	if (value === undefined) return '';
	return type === 'string' ? String(value) : JSON.stringify(value);
}

function isWorkflowNumber(value: number): boolean {
	return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

export function parseWorkflowJson(text: string): JsonValue {
	// JSON.parse accepts numeric overflows; these would become null on the wire.
	return JSON.parse(text, (_key: string, value: JsonValue) => {
		if (typeof value === 'number' && !isWorkflowNumber(value)) throw new SyntaxError();
		return value;
	}) as JsonValue;
}

type WorkflowInputProblem = 'required' | 'number' | 'boolean' | 'json';

export function decodeWorkflowInputs(
	schema: Readonly<Record<string, WorkflowInput>>,
	values: Readonly<Record<string, string>>,
): { inputs: JsonObject; errors: Record<string, WorkflowInputProblem> } {
	const inputs: [string, JsonValue][] = [];
	const errors: [string, WorkflowInputProblem][] = [];
	for (const [key, input] of Object.entries(schema)) {
		const raw = Object.hasOwn(values, key) ? values[key] : undefined;
		if (raw === undefined) {
			if (input.default !== undefined) inputs.push([key, input.default]);
			else errors.push([key, 'required']);
		} else if (input.type === 'string') {
			inputs.push([key, raw]);
		} else if (input.type === 'number') {
			const value = Number(raw);
			if (raw.trim() && isWorkflowNumber(value)) inputs.push([key, value]);
			else errors.push([key, 'number']);
		} else if (input.type === 'boolean') {
			if (raw === 'true' || raw === 'false') inputs.push([key, raw === 'true']);
			else errors.push([key, 'boolean']);
		} else {
			try {
				inputs.push([key, parseWorkflowJson(raw)]);
			} catch {
				errors.push([key, 'json']);
			}
		}
	}
	return { inputs: Object.fromEntries(inputs), errors: Object.fromEntries(errors) };
}
