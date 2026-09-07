import { parseChatCanvas, type ChatCanvas } from '$shared/chat-canvas';

export interface CanvasRecoveryPort {
	list(): ChatCanvas[];
	read(id: string): ChatCanvas | null;
	write(canvas: ChatCanvas): void;
	remove(id: string): void;
}

const prefix = 'chat-canvas-recovery-v1:';

// Tab-scoped drafts prevent one client from overwriting or clearing another client’s unsaved work.
export const browserCanvasRecovery: CanvasRecoveryPort = {
	list() {
		const storage = globalThis.sessionStorage;
		const drafts: ChatCanvas[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (!key?.startsWith(prefix)) continue;
			const draft = this.read(key.slice(prefix.length));
			if (draft) drafts.push(draft);
		}
		return drafts;
	},
	read(id) {
		const raw = globalThis.sessionStorage?.getItem(prefix + id);
		if (!raw) return null;
		const canvas = parseChatCanvas(JSON.parse(raw));
		if (canvas.id !== id) throw new Error('Invalid canvas recovery identity');
		return canvas;
	},
	write(canvas) {
		globalThis.sessionStorage?.setItem(prefix + canvas.id, JSON.stringify(canvas));
	},
	remove(id) {
		globalThis.sessionStorage?.removeItem(prefix + id);
	},
};
