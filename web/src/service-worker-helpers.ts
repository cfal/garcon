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

export async function precacheAppShell(
	cache: Cache,
	manifest: ServiceWorkerPrecacheManifest,
): Promise<void> {
	// Keeps the offline navigation fallback strict while allowing optional static files to drift.
	await cache.addAll(['/', ...manifest.build]);
	await Promise.allSettled(
		manifest.files.filter((url) => !isManifestPath(url)).map((url) => cache.add(url)),
	);
}

export function fetchWithTimeout(
	request: Request,
	options: {
		timeoutMs?: number;
		fetchImpl?: typeof fetch;
		onResponse?: (response: Response) => Promise<void> | void;
	} = {},
): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const network = fetchImpl(request).then((response) => {
		if (options.onResponse) {
			void Promise.resolve(options.onResponse(response)).catch(() => {
				// Caching is best-effort and should not change navigation outcome.
			});
		}
		return response;
	});

	return new Promise((resolve, reject) => {
		timer = setTimeout(() => {
			timer = null;
			reject(new Error('navigation timeout'));
		}, timeoutMs);

		network.then(
			(response) => {
				if (timer === null) return;
				clearTimeout(timer);
				timer = null;
				resolve(response);
			},
			(error) => {
				if (timer === null) return;
				clearTimeout(timer);
				timer = null;
				reject(error);
			},
		);
	});
}
