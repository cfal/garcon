import { createRandomId } from './random-id';

export const BROWSER_LOGOUT_EPOCH_KEY = 'garcon.logout-epoch';
const CLEANUP_KEY = 'garcon.logout-cleanup';
const CLEANUP_LIMIT_MS = 10_000;

export interface BrowserLogout {
	readonly epoch: string;
	readonly deadline: number;
	readonly coordinated: boolean;
}

let documentEpoch: string | null | undefined;
let retired = false;

export function readBrowserLogoutEpoch(): string | null {
	try {
		return globalThis.localStorage?.getItem(BROWSER_LOGOUT_EPOCH_KEY) ?? null;
	} catch {
		return null;
	}
}

export function captureBrowserDataLifetime(): void {
	if (documentEpoch === undefined) documentEpoch = readBrowserLogoutEpoch();
}

export function browserDocumentEpoch(): string | null {
	captureBrowserDataLifetime();
	return documentEpoch ?? null;
}

function pendingCleanup(): { epoch: string; deadline: number } | null {
	try {
		const value = JSON.parse(globalThis.localStorage?.getItem(CLEANUP_KEY) ?? 'null');
		if (
			typeof value?.epoch !== 'string' ||
			!Number.isSafeInteger(value.deadline) ||
			value.deadline <= Date.now() ||
			value.deadline > Date.now() + CLEANUP_LIMIT_MS
		)
			return null;
		return value;
	} catch {
		return null;
	}
}

export function canPersistBrowserData(): boolean {
	return isBrowserDataCurrent() && !pendingCleanup();
}

export function waitForBrowserLogoutCleanup(): Promise<void> | null {
	if (!pendingCleanup()) return null;
	return (async () => {
		const deadline = Date.now() + CLEANUP_LIMIT_MS;
		while (pendingCleanup() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	})();
}

export function canClearBrowserData(logout: BrowserLogout): boolean {
	return (
		Date.now() < logout.deadline &&
		(!logout.coordinated || pendingCleanup()?.epoch === logout.epoch)
	);
}

export function finishBrowserLogoutCleanup(logout: BrowserLogout): void {
	try {
		if (JSON.parse(globalThis.localStorage?.getItem(CLEANUP_KEY) ?? 'null')?.epoch === logout.epoch)
			globalThis.localStorage.removeItem(CLEANUP_KEY);
	} catch {
		/* The bounded notice expires when storage is unavailable. */
	}
}

// Fences pending checkpoints and pagehide flushes from an abandoned document.
export function isBrowserDataCurrent(): boolean {
	return !retired && (documentEpoch === undefined || documentEpoch === readBrowserLogoutEpoch());
}

export function retireBrowserData(): void {
	retired = true;
}

export function publishBrowserLogout(): BrowserLogout {
	retireBrowserData();
	const notice = { epoch: createRandomId(), deadline: Date.now() + CLEANUP_LIMIT_MS };
	try {
		// The admission gate precedes the epoch so fresh documents cannot write during cleanup.
		globalThis.localStorage.setItem(CLEANUP_KEY, JSON.stringify(notice));
		globalThis.localStorage.setItem(BROWSER_LOGOUT_EPOCH_KEY, notice.epoch);
		return { ...notice, coordinated: true };
	} catch {
		return { ...notice, coordinated: false };
	}
}
