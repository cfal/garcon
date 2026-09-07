const cachedFlags = new Map<string, boolean>();
let storageListenerInstalled = false;

export function readGarconDebugFlag(key: string): boolean {
	const cached = cachedFlags.get(key);
	if (cached !== undefined) return cached;

	let enabled = false;
	try {
		enabled = globalThis.localStorage?.getItem(key) === '1';
		installStorageListener();
	} catch {
		// Debug flags must not affect application behavior when storage is unavailable.
	}
	cachedFlags.set(key, enabled);
	return enabled;
}

function installStorageListener(): void {
	if (storageListenerInstalled || typeof globalThis.addEventListener !== 'function') return;
	storageListenerInstalled = true;
	globalThis.addEventListener('storage', (event: StorageEvent) => {
		if (event.storageArea !== globalThis.localStorage || !event.key) return;
		cachedFlags.delete(event.key);
	});
}
