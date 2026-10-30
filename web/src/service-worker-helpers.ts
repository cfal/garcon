export const NAVIGATION_TIMEOUT_MS = 3000;

export interface ServiceWorkerPrecacheManifest {
	build: string[];
	files: string[];
}

export function isManifestPath(value: string, basePath = ''): boolean {
	try {
		return new URL(value, 'http://localhost').pathname === `${basePath}/site.webmanifest`;
	} catch {
		return value === `${basePath}/site.webmanifest`;
	}
}

export function shouldCacheNavigationResponse(response: Response): boolean {
	if (!response.ok || response.type !== 'basic') return false;
	const cacheControl = response.headers.get('Cache-Control');
	return !cacheControl
		?.split(',')
		.some((directive) => directive.trim().toLowerCase() === 'no-store');
}

function isFontPath(path: string): boolean {
	return /\.(?:woff2?|ttf|otf)$/.test(path);
}

// Only immutable current-build fonts can safely survive a version change.
export async function preserveCachedFonts(
	current: Pick<Cache, 'match' | 'put'>,
	previous: Pick<Cache, 'match'>,
	manifest: ServiceWorkerPrecacheManifest,
): Promise<void> {
	for (const path of manifest.build.filter(isFontPath)) {
		if (await current.match(path)) continue;
		const response = await previous.match(path);
		if (response?.ok) await current.put(path, response);
	}
}

export async function precacheAppShell(
	cache: Pick<Cache, 'addAll' | 'add'>,
	manifest: ServiceWorkerPrecacheManifest,
	basePath = '',
): Promise<void> {
	// Keeps the offline navigation fallback strict while allowing optional static files to drift.
	// Fonts are cached when requested; eager downloads defeat unicode-range and font preferences.
	await cache.addAll([`${basePath}/`, ...manifest.build.filter((url) => !isFontPath(url))]);
	await Promise.allSettled(
		manifest.files
			.filter((url) => !isManifestPath(url, basePath) && !isFontPath(url))
			.map((url) => cache.add(url)),
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
