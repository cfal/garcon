export function errorMessage(error: unknown, fallback?: string): string {
	if (error instanceof Error && error.message) return error.message;
	return fallback ?? String(error);
}
