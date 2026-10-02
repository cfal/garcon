/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { build, files, version } from '$service-worker';
import {
	withNavigationTimeout,
	isManifestPath,
	precacheAppShell,
	shouldCacheNavigationResponse,
	type ServiceWorkerPrecacheManifest,
} from './service-worker-helpers';

const CACHE_NAME = `garcon-${version}`;

const CACHE_PREFIX = 'garcon-';
const PRECACHE_MANIFEST: ServiceWorkerPrecacheManifest = { build, files };

// Paths that must never be cached (API, WebSocket upgrades).
const PASSTHROUGH_PREFIXES = ['/api', '/ws'];

function isPassthrough(url: URL): boolean {
	return PASSTHROUGH_PREFIXES.some((p) => url.pathname.startsWith(p));
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
			.then((cache) => precacheAppShell(cache, PRECACHE_MANIFEST))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener('activate', (event) => {
	// Evict old garcon caches from previous deploys. Only touch our own prefix.
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
						.map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	// Never intercept API calls, WebSocket handshakes, or cross-origin requests.
	if (url.origin !== self.location.origin) return;
	if (isPassthrough(url)) return;

	// Non-GET requests (form POSTs, etc.) go straight to network.
	if (event.request.method !== 'GET') return;
	if (isManifestPath(url.pathname)) return;

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
				caches.match('/').then((r) => r ?? Response.error()),
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
