export const NAVIGATION_TIMEOUT_MS = 3000;

export interface ServiceWorkerPrecacheManifest {
	build: string[];
	files: string[];
}

export function isManifestPath(value: string): boolean {
	try {
		return new URL(value, 'http://localhost').pathname === '/site.webmanifest';
	} catch {
		return value === '/site.webmanifest';
	}
}

export function shouldCacheNavigationResponse(response: Response): boolean {
	if (!response.ok || response.type !== 'basic') return false;
	const cacheControl = response.headers.get('Cache-Control');
	return !cacheControl
		?.split(',')
		.some((directive) => directive.trim().toLowerCase() === 'no-store');
}

export async function precacheAppShell(
	cache: Pick<Cache, 'addAll' | 'add'>,
	manifest: ServiceWorkerPrecacheManifest,
): Promise<void> {
	// Keeps the offline navigation fallback strict while allowing optional static files to drift.
	await cache.addAll(['/', ...manifest.build]);
	await Promise.allSettled(
		manifest.files.filter((url) => !isManifestPath(url)).map((url) => cache.add(url)),
	);
}

export function withNavigationTimeout(
	network: Promise<Response>,
	timeoutMs = NAVIGATION_TIMEOUT_MS,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error('navigation timeout'));
		}, timeoutMs);

		network.then(
			(response) => {
				clearTimeout(timer);
				resolve(response);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
