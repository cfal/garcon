export function resolve(path: string, params?: Record<string, string>): string {
	const pathname = path.startsWith('/') ? path : `/${path}`;
	return pathname.replace(/\[([^\]]+)\]/g, (_, key: string) => params?.[key] ?? '');
}
export function asset(path: string): string {
	return `/${path}`;
}
