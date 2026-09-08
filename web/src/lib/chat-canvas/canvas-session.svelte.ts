import type { CanvasContent, ChatCanvas, UpdateCanvasRequest } from '$shared/chat-canvas';
import { ApiError } from '$lib/api/client.js';
import { CanvasDocumentState } from './canvas-document.svelte.js';
import type { CanvasRecoveryPort } from './canvas-recovery.js';
import { claimCanvasRecovery } from './canvas-recovery-lease.js';

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
	#deleting = false;
	readonly #recoveryLease: ReturnType<typeof claimCanvasRecovery>;
	#interactions = new Set<symbol>();
	#interactionGeneration = 0;

	constructor(
		canvas: ChatCanvas,
		private readonly api: CanvasSessionPort,
		private readonly recovery: CanvasRecoveryPort,
		private readonly onSaved: (canvas: ChatCanvas) => void,
	) {
		this.#recoveryLease = claimCanvasRecovery(recovery, canvas.id);
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
		if (this.#disposed || this.#deleting || !this.#recoveryLease.isCurrent()) return false;
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

	async prepareDelete(): Promise<() => void> {
		this.#deleting = true;
		this.#clearTimer();
		if (this.#pending) await this.#pending;
		return () => {
			this.#deleting = false;
			if (!this.#disposed && this.#recoveryLease.isCurrent() && this.dirty && !this.conflict)
				this.#schedule();
		};
	}

	get interacting(): boolean {
		return this.#interactions.size > 0;
	}

	beginInteraction(): () => void {
		const token = Symbol();
		this.#interactions.add(token);
		this.#interactionGeneration += 1;
		return () => this.#interactions.delete(token);
	}

	backup(): boolean {
		return this.#writeRecovery(this.document.content);
	}

	preserveForExit(): void {
		if (this.dirty || this.conflict) this.backup();
		if (!this.conflict) void this.flush();
	}

	async refresh(): Promise<void> {
		if (
			this.dirty ||
			this.saving ||
			this.conflict ||
			this.#disposed ||
			!this.#recoveryLease.isCurrent() ||
			this.interacting
		)
			return;
		const before = this.saved;
		const interactionGeneration = this.#interactionGeneration;
		try {
			const latest = await this.api.get(this.saved.id);
			if (
				this.saved !== before ||
				this.dirty ||
				this.saving ||
				this.#disposed ||
				!this.#recoveryLease.isCurrent() ||
				interactionGeneration !== this.#interactionGeneration ||
				this.interacting
			)
				return;
			if (latest.revision !== this.saved.revision) {
				this.saved = latest;
				this.document.replace(latest.content);
				this.onSaved(latest);
			}
			this.error = null;
		} catch (error) {
			if (!this.#disposed && interactionGeneration === this.#interactionGeneration)
				this.#failure(error);
		}
	}

	async discardAndReload(): Promise<boolean> {
		if (this.#disposed || !this.#recoveryLease.isCurrent()) return false;
		this.#clearTimer();
		this.reloading = true;
		if (this.#pending) await this.#pending;
		try {
			if (this.#disposed || !this.#recoveryLease.isCurrent()) return false;
			const latest = await this.api.get(this.saved.id);
			if (this.#disposed || !this.#recoveryLease.isCurrent()) return false;
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
		this.#recoveryLease.release();
	}

	dispose(): void {
		if (this.#disposed) return;
		if (this.dirty || this.conflict) this.backup();
		this.abandon();
	}

	#changed(content: CanvasContent): void {
		if (this.#disposed || !this.#recoveryLease.isCurrent()) return;
		this.#writeRecovery(content);
		if (!this.conflict) this.#schedule();
	}

	#writeRecovery(content: CanvasContent): boolean {
		if (!this.#recoveryLease.isCurrent()) return false;
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
		if (this.#deleting) return;
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
			while (this.dirty && !this.#deleting) {
				const content = this.document.content;
				const saved = await this.api.update({
					id: this.saved.id,
					expectedRevision: this.saved.revision,
					content,
				});
				if (this.#disposed || !this.#recoveryLease.isCurrent()) return false;
				this.saved = saved;
				this.onSaved(saved);
				if (this.dirty) this.#writeRecovery(this.document.content);
			}
			if (this.dirty) return false;
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
		if (!this.#recoveryLease.isCurrent()) return;
		try {
			this.recovery.remove(this.saved.id);
			this.recoveryError = false;
		} catch {
			this.recoveryError = true;
		}
	}

	#failure(error: unknown): void {
		if (this.#disposed || !this.#recoveryLease.isCurrent()) return;
		this.conflict =
			this.conflict ||
			(error instanceof ApiError &&
				(error.status === 409 || error.status === 404 || error.errorCode === 'CANVAS_CORRUPT'));
		this.error = error instanceof Error ? error.message : String(error);
	}
}
