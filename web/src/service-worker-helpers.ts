export const NAVIGATION_TIMEOUT_MS = 3000;

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

export async function preserveCachedAssets(
	current: Pick<Cache, 'match' | 'put'>,
	previous: Pick<Cache, 'match' | 'keys'>,
	immutable: ReadonlySet<string>,
): Promise<void> {
	for (const request of await previous.keys()) {
		if (!immutable.has(request.url) || await current.match(request)) continue;
		const response = await previous.match(request);
		if (response?.ok) await current.put(request, response);
	}
}

export async function precacheAppShell(
	cache: Pick<Cache, 'addAll'>,
	eager: readonly string[],
	basePath = '',
): Promise<void> {
	await cache.addAll([`${basePath}/`, ...eager.map((path) => `${basePath}/${path}`)]);
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
