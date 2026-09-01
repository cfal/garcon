export function safeLoginReturnTo(raw: string | null): string {
	if (!raw?.startsWith('/')) return '/';
	if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
	return raw;
}
