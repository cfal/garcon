/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { build, files, version } from '$service-worker';

const CACHE_NAME = `garcon-${version}`;

const CACHE_PREFIX = 'garcon-';

// App shell: Vite-built JS/CSS chunks + static assets (icons, manifest, etc.)
// Include '/' so the offline navigation fallback has a guaranteed cache hit.
const PRECACHE_URLS = ['/', ...build, ...files];

// Paths that must never be cached (API, WebSocket upgrades).
const PASSTHROUGH_PREFIXES = ['/api', '/ws', '/shell'];

function isPassthrough(url: URL): boolean {
	return PASSTHROUGH_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(PRECACHE_URLS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	// Evict old garcon caches from previous deploys. Only touch our own prefix.
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
				)
			)
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	// Never intercept API calls, WebSocket handshakes, or cross-origin requests.
	if (url.origin !== self.location.origin) return;
	if (isPassthrough(url)) return;

	// Non-GET requests (form POSTs, etc.) go straight to network.
	if (event.request.method !== 'GET') return;

	// Navigation requests (HTML): network-first so the latest deploy is picked up,
	// falling back to the cached app shell for offline/flaky-network scenarios.
	if (event.request.mode === 'navigate') {
		event.respondWith(
			fetch(event.request)
				.then((response) => {
					if (response.ok && response.type === 'basic') {
						const clone = response.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
					}
					return response;
				})
				.catch(() => caches.match('/').then((r) => r ?? Response.error()))
		);
		return;
	}

	// Static assets: cache-first (they are fingerprinted by Vite).
	event.respondWith(
		caches.match(event.request).then((cached) => {
			if (cached) return cached;
			return fetch(event.request).then((response) => {
				if (response.ok) {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
				}
				return response;
			});
		})
	);
});
