/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { build, files, version } from '$service-worker';
import {
	fetchWithTimeout,
	isManifestPath,
	precacheAppShell,
	type ServiceWorkerPrecacheManifest,
} from './service-worker-helpers';
import {
	GARCON_NOTIFICATION_MESSAGE_TYPE,
	notificationNavigationPath,
	parsePushPayload,
} from './service-worker-notifications';

const CACHE_NAME = `garcon-${version}`;

const CACHE_PREFIX = 'garcon-';
const PRECACHE_MANIFEST: ServiceWorkerPrecacheManifest = { build, files };

// Paths that must never be cached (API, WebSocket upgrades).
const PASSTHROUGH_PREFIXES = ['/api', '/ws', '/shell'];

function isPassthrough(url: URL): boolean {
	return PASSTHROUGH_PREFIXES.some((p) => url.pathname.startsWith(p));
}

function cacheSuccessfulNavigation(request: Request, response: Response): void {
	if (!response.ok || response.type !== 'basic') return;
	const clone = response.clone();
	void caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
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
		event.respondWith(
			fetchWithTimeout(event.request, {
				onResponse: (response) => cacheSuccessfulNavigation(event.request, response),
			})
				.catch(() => caches.match('/').then((r) => r ?? Response.error())),
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
		}),
	);
});

self.addEventListener('push', (event) => {
	const rawPayload = event.data?.text() ?? '';
	const payload = parsePushPayload(rawPayload, self.location.origin);
	if (!payload) return;

	event.waitUntil(
		(async () => {
			await self.registration.showNotification(payload.title, payload.options);
			if (payload.badgeCount === null) return;
			const badgeNavigator = navigator as Navigator & {
				setAppBadge?: (count: number) => Promise<void>;
			};
			await badgeNavigator.setAppBadge?.(payload.badgeCount);
		})(),
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const navigatePath = notificationNavigationPath(event.notification.data, self.location.origin) ?? '/';

	event.waitUntil(
		(async () => {
			const clients = await self.clients.matchAll({
				type: 'window',
				includeUncontrolled: true,
			});
			const existing = clients.find((client): client is WindowClient => {
				if (!('focus' in client)) return false;
				try {
					return new URL(client.url).origin === self.location.origin;
				} catch {
					return false;
				}
			});
			if (existing) {
				await existing.focus();
				existing.postMessage({
					type: GARCON_NOTIFICATION_MESSAGE_TYPE,
					url: navigatePath,
				});
				return;
			}
			await self.clients.openWindow(navigatePath);
		})(),
	);
});
