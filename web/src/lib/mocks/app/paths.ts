export const base = '';
export function resolve(path: string, params?: Record<string, string>): string {
	return base + path.replace(/\[([^\]]+)\]/g, (_, key: string) => params?.[key] ?? '');
}
export function asset(path: string): string {
	return base + path;
}
