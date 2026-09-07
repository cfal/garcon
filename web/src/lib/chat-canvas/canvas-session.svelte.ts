import type { CanvasContent, ChatCanvas, UpdateCanvasRequest } from '$shared/chat-canvas';
import { ApiError } from '$lib/api/client.js';
import { CanvasDocumentState } from './canvas-document.svelte.js';
import type { CanvasRecoveryPort } from './canvas-recovery.js';

export interface CanvasSessionPort {
	update(request: UpdateCanvasRequest): Promise<ChatCanvas>;
	get(id: string): Promise<ChatCanvas>;
}

export class CanvasSession {
	readonly document: CanvasDocumentState;
	saved: ChatCanvas;
	error = $state<string | null>(null);
	conflict = $state(false);
	saving = $state(false);
	reloading = $state(false);
	recoveryError = $state(false);
	#timer: ReturnType<typeof setTimeout> | null = null;
	#pending: Promise<boolean> | null = null;
	#disposed = false;

	constructor(
		canvas: ChatCanvas,
		private readonly api: CanvasSessionPort,
		private readonly recovery: CanvasRecoveryPort,
		private readonly onSaved: (canvas: ChatCanvas) => void,
	) {
		this.saved = $state.raw(canvas);
		let content = canvas.content;
		try {
			const draft = recovery.read(canvas.id);
			if (draft && JSON.stringify(draft.content) !== JSON.stringify(content)) {
				content = draft.content;
				this.conflict = draft.revision !== canvas.revision;
			}
		} catch {
			this.recoveryError = true;
		}
		this.document = new CanvasDocumentState(content, (next) => this.#changed(next));
		if (this.dirty && !this.conflict) this.#schedule();
	}

	get dirty(): boolean {
		return JSON.stringify(this.document.content) !== JSON.stringify(this.saved.content);
	}

	async flush(): Promise<boolean> {
		this.#clearTimer();
		if (this.conflict) return false;
		if (this.#pending) return this.#pending;
		this.error = null;
		this.#pending = this.#save();
		try {
			return await this.#pending;
		} finally {
			this.#pending = null;
		}
	}

	async preserveBeforeSwitch(): Promise<boolean> {
		if (await this.flush()) return true;
		return this.conflict && this.#writeRecovery(this.document.content);
	}

	async refresh(): Promise<void> {
		if (this.dirty || this.saving || this.conflict || this.#disposed) return;
		const before = this.saved;
		try {
			const latest = await this.api.get(this.saved.id);
			if (this.saved !== before || this.dirty || this.saving || this.#disposed) return;
			if (latest.revision !== this.saved.revision) {
				this.saved = latest;
				this.document.replace(latest.content);
				this.onSaved(latest);
			}
			this.error = null;
		} catch (error) {
			this.#failure(error);
		}
	}

	async discardAndReload(): Promise<boolean> {
		this.#clearTimer();
		this.reloading = true;
		if (this.#pending) await this.#pending;
		try {
			const latest = await this.api.get(this.saved.id);
			this.saved = latest;
			this.document.replace(latest.content);
			this.conflict = false;
			this.error = null;
			this.#removeRecovery();
			this.onSaved(latest);
			return true;
		} catch (error) {
			this.#failure(error);
			return false;
		} finally {
			this.reloading = false;
		}
	}

	discardRecovery(): void {
		this.#removeRecovery();
	}

	abandon(): void {
		this.#disposed = true;
		this.#clearTimer();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.abandon();
		if (this.dirty && !this.conflict) void this.flush();
	}

	#changed(content: CanvasContent): void {
		this.#writeRecovery(content);
		if (!this.conflict) this.#schedule();
	}

	#writeRecovery(content: CanvasContent): boolean {
		try {
			this.recovery.write({ ...this.saved, content });
			this.recoveryError = false;
			return true;
		} catch {
			this.recoveryError = true;
			return false;
		}
	}

	#schedule(): void {
		this.#clearTimer();
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.flush();
		}, 500);
	}

	#clearTimer(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}

	async #save(): Promise<boolean> {
		this.saving = true;
		try {
			while (this.dirty) {
				const content = this.document.content;
				const saved = await this.api.update({
					id: this.saved.id,
					expectedRevision: this.saved.revision,
					content,
				});
				this.saved = saved;
				this.onSaved(saved);
				if (this.dirty) this.#writeRecovery(this.document.content);
			}
			this.#removeRecovery();
			return true;
		} catch (error) {
			this.#failure(error);
			return false;
		} finally {
			this.saving = false;
		}
	}

	#removeRecovery(): void {
		try {
			this.recovery.remove(this.saved.id);
			this.recoveryError = false;
		} catch {
			this.recoveryError = true;
		}
	}

	#failure(error: unknown): void {
		this.conflict =
			this.conflict ||
			(error instanceof ApiError &&
				(error.status === 409 || error.status === 404 || error.errorCode === 'CANVAS_CORRUPT'));
		this.error = error instanceof Error ? error.message : String(error);
	}
}
