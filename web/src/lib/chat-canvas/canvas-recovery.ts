import { parseChatCanvas, type ChatCanvas } from '$shared/chat-canvas';
import { canPersistBrowserData, isBrowserDataCurrent } from '$lib/utils/browser-data-lifetime';

export interface CanvasRecoveryPort {
	list(): ChatCanvas[];
	read(id: string): ChatCanvas | null;
	write(canvas: ChatCanvas): void;
	remove(id: string): void;
}

const prefix = 'chat-canvas-recovery-v1:viewer:';
const capacity = 32;

function parseRecovery(raw: string, id: string): ChatCanvas {
	const canvas = parseChatCanvas(JSON.parse(raw));
	if (canvas.id !== id) throw new Error('Invalid canvas recovery identity');
	return canvas;
}

// Captures the viewer for the lifetime of the controller, including late saves.
export function createBrowserCanvasRecovery(viewer: () => string | null): CanvasRecoveryPort {
	const owner = viewer();
	const scope = `${prefix}${encodeURIComponent(owner ?? '')}:`;
	const canRead = () => owner !== null && viewer() === owner && isBrowserDataCurrent();
	const keys = (storage: Storage) => {
		const scoped: string[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key?.startsWith(scope)) scoped.push(key);
		}
		return scoped;
	};
	function read(storage: Storage, key: string): ChatCanvas | null {
		const raw = storage.getItem(key);
		if (raw === null) return null;
		try {
			return parseRecovery(raw, key.slice(scope.length));
		} catch {
			if (canPersistBrowserData()) {
				try {
					storage.removeItem(key);
				} catch {
					// Malformed data is never exposed, even when storage will not remove it.
				}
			}
			return null;
		}
	}
	return {
		list() {
			if (!canRead()) return [];
			const storage = globalThis.sessionStorage;
			return keys(storage).flatMap((key) => read(storage, key) ?? []);
		},
		read(id) {
			return canRead() ? read(globalThis.sessionStorage, scope + id) : null;
		},
		write(canvas) {
			if (!canRead() || !canPersistBrowserData()) throw new Error('Canvas recovery is unavailable');
			const storage = globalThis.sessionStorage;
			const key = scope + canvas.id;
			if (storage.getItem(key) === null) {
				const scoped = keys(storage);
				if (scoped.length >= capacity && scoped.filter((entry) => read(storage, entry) !== null).length >= capacity) {
					throw new Error('Canvas recovery is full');
				}
			}
			storage.setItem(key, JSON.stringify(canvas));
		},
		remove(id) {
			if (canRead() && canPersistBrowserData()) globalThis.sessionStorage.removeItem(scope + id);
		},
	};
}
