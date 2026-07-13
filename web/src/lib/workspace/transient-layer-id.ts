let nextTransientLayerId = 0;

export function allocateTransientLayerId(prefix: string): string {
	nextTransientLayerId += 1;
	return `${prefix}-${nextTransientLayerId}`;
}
