export function safeLoginReturnTo(raw: string | null): string {
	if (!raw?.startsWith('/')) return '/';
	if (raw.startsWith('//') || [...raw].some((char) => char === '\\' || char.charCodeAt(0) <= 32))
		return '/';
	const parsed = new URL(raw, 'https://garcon.invalid');
	return parsed.origin === 'https://garcon.invalid' && !parsed.pathname.startsWith('//')
		? parsed.pathname + parsed.search + parsed.hash
		: '/';
}
