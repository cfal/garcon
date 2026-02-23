// SvelteKit $app/navigation mock for unit tests.

export function goto(_url: string, _opts?: Record<string, unknown>) {
	return Promise.resolve();
}

export function beforeNavigate(_callback: (navigation: unknown) => void) {}

export function afterNavigate(_callback: (navigation: unknown) => void) {}

export function invalidate(_url: string) {
	return Promise.resolve();
}

export function invalidateAll() {
	return Promise.resolve();
}
