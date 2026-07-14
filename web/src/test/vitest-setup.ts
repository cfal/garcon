// Node may expose a partial global localStorage (e.g. via experimental flags) that
// shadows happy-dom and omits clear(). Tests expect the full Storage interface.
function installMemoryLocalStorage(): void {
	const data: Record<string, string> = {};

	globalThis.localStorage = {
		get length() {
			return Object.keys(data).length;
		},
		clear() {
			for (const key of Object.keys(data)) {
				delete data[key];
			}
		},
		getItem(key: string) {
			return Object.hasOwn(data, key) ? data[key] : null;
		},
		setItem(key: string, value: string) {
			data[key] = String(value);
		},
		removeItem(key: string) {
			delete data[key];
		},
		key(index: number) {
			const keys = Object.keys(data);
			return keys[index] ?? null;
		},
	} as Storage;
}

const ls = globalThis.localStorage;
if (!ls || typeof ls.clear !== 'function') {
	installMemoryLocalStorage();
}

const rejectUnexpectedFetch: typeof fetch = (input) =>
	Promise.reject(new Error(`Unexpected network request in test: ${String(input)}`));

globalThis.fetch = rejectUnexpectedFetch;
