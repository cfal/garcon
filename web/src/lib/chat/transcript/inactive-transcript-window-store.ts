import type { ActiveTranscriptState } from './active-transcript-state.svelte.js';
import type { ConversationPanelRestoreTarget } from './conversation-panel-restore-target.js';
import type { ConversationTranscriptOverlayMutation } from './conversation-transcript-overlay-store.svelte.js';

export interface InactiveTranscriptWindow {
	readonly surfaceId: string;
	readonly chatId: string;
	readonly transcript: ActiveTranscriptState;
	readonly target: ConversationPanelRestoreTarget;
}

export class InactiveTranscriptWindowStore {
	#windows = new Map<string, InactiveTranscriptWindow & { count: number; bytes: number }>();
	#targets = new Map<string, Pick<InactiveTranscriptWindow, 'surfaceId' | 'chatId' | 'target'> & { view: string }>();
	constructor(private readonly limits = { windows: 4, messages: 8000, bytes: 24 * 1024 * 1024 }) {}
	get size(): number { return this.#windows.size; }
	transcriptsForChat(chatId: string): readonly ActiveTranscriptState[] { return [...this.#windows.values()].filter(window => window.chatId === chatId).map(window => window.transcript); }
	#key(surfaceId: string, chatId: string): string { return JSON.stringify([surfaceId, chatId]); }
	park(window: InactiveTranscriptWindow): void {
		this.discard(window.surfaceId, window.chatId);
		this.#targets.set(this.#key(window.surfaceId, window.chatId), { surfaceId: window.surfaceId, chatId: window.chatId,
			target: window.target, view: window.transcript.transcriptViewId });
		const snapshot = window.transcript.display;
		// Input overlays are not body-store leases; their live owner retains them instead.
		if (window.transcript.visibleOptimisticInputs.length) { window.transcript.dispose(); return; }
		const details = [...snapshot.details.values(), ...snapshot.protectedRows.map(row => row.detail)];
		const usage = window.transcript.bodyStore.usage(window.transcript.controller);
		const bytes = usage.bytes + JSON.stringify([snapshot.window, snapshot.expansions, snapshot.protectedRows, details]).length * 2;
		if (!snapshot.window || usage.count > this.limits.messages || bytes > this.limits.bytes) { window.transcript.dispose(); return; }
		window.transcript.controller.park();
		this.#windows.set(this.#key(window.surfaceId, window.chatId), { ...window, count: usage.count, bytes });
		let count = 0, total = 0;
		for (const entry of this.#windows.values()) { count += entry.count; total += entry.bytes; }
		while (this.size > this.limits.windows || count > this.limits.messages || total > this.limits.bytes) {
			const oldest = this.#windows.values().next().value;
			if (!oldest) break;
			count -= oldest.count; total -= oldest.bytes;
			this.#evict(this.#key(oldest.surfaceId, oldest.chatId));
		}
	}
	take(surfaceId: string, chatId: string): InactiveTranscriptWindow | null {
		const key = this.#key(surfaceId, chatId), window = this.#windows.get(key);
		this.#windows.delete(key);
		return window ?? null;
	}
	restoreTarget(surfaceId: string, chatId: string): ConversationPanelRestoreTarget | null {
		return this.#targets.get(this.#key(surfaceId, chatId))?.target ?? null;
	}
	takeRestoreTarget(surfaceId: string, chatId: string): ConversationPanelRestoreTarget | null {
		const target = this.restoreTarget(surfaceId, chatId);
		this.#targets.delete(this.#key(surfaceId, chatId));
		return target;
	}
	discard(surfaceId: string, chatId: string): void {
		const key = this.#key(surfaceId, chatId);
		this.#targets.delete(key);
		this.#evict(key);
	}
	#evict(key: string): void {
		this.#windows.get(key)?.transcript.dispose();
		this.#windows.delete(key);
	}
	observeHead(chatId: string, view: string, ordinal: number): void {
		for (const target of this.#targets.values()) {
			if (target.chatId === chatId && target.view !== view) this.discard(target.surfaceId, chatId);
		}
		for (const window of this.#windows.values()) {
			if (window.chatId !== chatId) continue;
			window.transcript.observeHead(view, ordinal);
		}
	}
	applyOverlayMutation(chatId: string, mutation: ConversationTranscriptOverlayMutation): void {
		for (const window of this.#windows.values()) {
			if (window.chatId !== chatId) continue;
			if (window.transcript.visibleOptimisticInputs.length) this.#evict(this.#key(window.surfaceId, chatId));
			else window.transcript.applySharedOverlayMutation(mutation);
		}
	}
	removeChat(chatId: string): void { for (const target of this.#targets.values()) if (target.chatId === chatId) this.discard(target.surfaceId, chatId); }
	pruneSurfaces(ids: ReadonlySet<string>): void { for (const target of this.#targets.values()) if (!ids.has(target.surfaceId)) this.discard(target.surfaceId, target.chatId); }
	clear(): void { for (const window of this.#windows.values()) window.transcript.dispose(); this.#windows.clear(); this.#targets.clear(); }
}
