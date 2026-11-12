// Bounds traversal before allocating JSON, then checks the exact escaped size.
export function serializeTranscriptWithinBudget(
	value: unknown,
	limits: { characters: number; values: number; depth: number },
): string | null {
	let estimatedCharacters = 0;
	let visitedValues = 0;
	function visit(value: unknown, depth: number): boolean {
		visitedValues += 1;
		if (visitedValues > limits.values || depth > limits.depth) return false;
		estimatedCharacters += typeof value === 'string' ? value.length + 2 : 32;
		if (estimatedCharacters > limits.characters) return false;
		if (value === null || typeof value !== 'object') return true;
		if ('toJSON' in value) return false;
		if (Array.isArray(value)) {
			if (value.length > limits.values - visitedValues) return false;
			for (const item of value) {
				if (!visit(item, depth + 1)) return false;
			}
			return true;
		}
		const record = value as Record<string, unknown>;
		for (const key in record) {
			if (!Object.hasOwn(record, key)) continue;
			estimatedCharacters += key.length + 3;
			if (estimatedCharacters > limits.characters) return false;
			if (!visit(record[key], depth + 1)) return false;
		}
		return true;
	}
	if (!visit(value, 0)) return null;
	const serialized = JSON.stringify(value);
	return serialized && serialized.length <= limits.characters ? serialized : null;
}
