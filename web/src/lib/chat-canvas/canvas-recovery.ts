import { parseChatCanvas, type ChatCanvas } from '$shared/chat-canvas';

export interface CanvasRecoveryPort {
	list(): ChatCanvas[];
	read(id: string): ChatCanvas | null;
	write(canvas: ChatCanvas): void;
	remove(id: string): void;
}

const prefix = 'chat-canvas-recovery-v1:';

function parseRecovery(raw: string, id: string): ChatCanvas {
	const canvas = parseChatCanvas(JSON.parse(raw));
	if (canvas.id !== id) throw new Error('Invalid canvas recovery identity');
	return canvas;
}

// Tab-scoped drafts prevent one client from overwriting or clearing another client’s unsaved work.
export const browserCanvasRecovery: CanvasRecoveryPort = {
	list() {
		const storage = globalThis.sessionStorage;
		const drafts: ChatCanvas[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (!key?.startsWith(prefix)) continue;
			const raw = storage.getItem(key);
			if (!raw) continue;
			try {
				drafts.push(parseRecovery(raw, key.slice(prefix.length)));
			} catch {
				// Preserves malformed entries for recovery without hiding readable drafts.
			}
		}
		return drafts;
	},
	read(id) {
		const raw = globalThis.sessionStorage.getItem(prefix + id);
		if (!raw) return null;
		return parseRecovery(raw, id);
	},
	write(canvas) {
		globalThis.sessionStorage.setItem(prefix + canvas.id, JSON.stringify(canvas));
	},
	remove(id) {
		globalThis.sessionStorage.removeItem(prefix + id);
	},
};
