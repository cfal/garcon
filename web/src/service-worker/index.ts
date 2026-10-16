declare const self: ServiceWorkerGlobalScope;

import { openNotificationChat } from '../service-worker-notifications.js';
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';
import { stripBasePath } from '../../../common/base-path.js';
import {
	withNavigationTimeout,
	isManifestPath,
	precacheAppShell,
	shouldCacheNavigationResponse,
	type ServiceWorkerPrecacheManifest,
} from '../service-worker-helpers.js';

// The same build can be served at different runtime mounts.
const base = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const CACHE_PREFIX = `garcon:${encodeURIComponent(base)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${version}`;
const PRECACHE_MANIFEST: ServiceWorkerPrecacheManifest = {
	build: immutable.map(({ path }) => `${base}/${path}`),
	files: assets.map(({ path }) => `${base}/${path}`),
};

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients
			.matchAll({ type: 'window', includeUncontrolled: true })
			.then((windows) =>
				openNotificationChat(
					event.notification.data?.chatId,
					self.location.origin,
					windows as WindowClient[],
					(url) => self.clients.openWindow(url),
					base,
				),
			),
	);
});
// Paths that must never be cached (API, WebSocket upgrades).
const PASSTHROUGH_PREFIXES = ['/api', '/ws'];

function isPassthrough(pathname: string): boolean {
	return PASSTHROUGH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

async function cacheSuccessfulNavigation(request: Request, response: Response): Promise<void> {
	if (!shouldCacheNavigationResponse(response)) return;
	const clone = response.clone();
	const cache = await caches.open(CACHE_NAME);
	await cache.put(request, clone);
}

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => precacheAppShell(cache, PRECACHE_MANIFEST, base))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener('activate', (event) => {
	// Root upgrades also retire caches created before mount-specific naming.
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((name) => {
							const legacyRootCache = base === '' && name.startsWith('garcon-');
							return legacyRootCache || (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
						})
						.map((name) => caches.delete(name)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	// Never intercept API calls, WebSocket handshakes, or cross-origin requests.
	if (url.origin !== self.location.origin) return;
	const pathname = stripBasePath(url.pathname, base);
	if (pathname === null || isPassthrough(pathname)) return;

	// Non-GET requests (form POSTs, etc.) go straight to network.
	if (event.request.method !== 'GET') return;
	if (isManifestPath(pathname) || pathname === '/_app/version.json') return;

	// Navigation requests (HTML): network-first so the latest deploy is picked up,
	// falling back to the cached app shell for offline/flaky-network scenarios.
	if (event.request.mode === 'navigate') {
		const network = fetch(event.request);
		// Registers before the timeout settles so late responses can still populate the cache.
		event.waitUntil(
			network
				.then((response) => cacheSuccessfulNavigation(event.request, response))
				.catch(() => undefined),
		);
		event.respondWith(
			withNavigationTimeout(network).catch(() =>
				caches
					.open(CACHE_NAME)
					.then((cache) => cache.match(`${base}/`))
					.then((r) => r ?? Response.error()),
			),
		);
		return;
	}

	// Static assets: cache-first (they are fingerprinted by Vite).
	const asset = caches.open(CACHE_NAME).then(async (cache) => {
		const cached = await cache.match(event.request);
		return { cache, cached, response: cached ?? (await fetch(event.request)) };
	});
	event.waitUntil(
		asset
			.then(({ cache, cached, response }) => {
				if (!cached && response.ok) return cache.put(event.request, response.clone());
			})
			.catch(() => undefined),
	);
	event.respondWith(asset.then(({ response }) => response));
});
