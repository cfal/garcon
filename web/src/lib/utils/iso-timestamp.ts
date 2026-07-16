export function canonicalIsoTimestamp(value: string | null | undefined): string | null {
	if (!value) return null;

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString() === value ? value : null;
}
