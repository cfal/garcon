import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { WorkspaceLayoutSnapshot } from './surface-types.js';
import type { WorkspaceHostSize } from './window-geometry-policy.js';

interface WorkspaceHostGeometryStateDeps {
	getSnapshot(): WorkspaceLayoutSnapshot;
	getIsMobile(): boolean;
	onResizeSettled(): Promise<boolean>;
}

const WORKSPACE_RESIZE_SETTLE_MS = 150;

export class WorkspaceHostGeometryState {
	size = $state.raw<WorkspaceHostSize | null>(null);
	#element: HTMLElement | null = null;
	#measureFrame: number | null = null;
	#settleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly deps: WorkspaceHostGeometryStateDeps) {}

	readonly attach: Attachment<HTMLElement> = (element) =>
		untrack(() => {
			this.#element = element;
			this.#measure();
			const observer = new ResizeObserver(() => this.#scheduleMeasure());
			observer.observe(element);
			return () => {
				observer.disconnect();
				if (this.#measureFrame !== null) cancelAnimationFrame(this.#measureFrame);
				if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
				this.#measureFrame = null;
				this.#settleTimer = null;
				this.#element = null;
				this.size = null;
			};
		});

	layoutPublished(): void {
		// Fullscreen and mobile change the host box on the following DOM update.
		this.#scheduleMeasure();
	}

	#scheduleMeasure(): void {
		if (!this.#element || this.#measureFrame !== null) return;
		if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
		this.#settleTimer = null;
		this.#measureFrame = requestAnimationFrame(() => {
			this.#measureFrame = null;
			this.#measure();
		});
	}

	#measure(): void {
		const rect = this.#element?.getBoundingClientRect();
		if (!rect || rect.width <= 0 || rect.height <= 0) {
			this.size = null;
			return;
		}
		if (!this.size || this.size.width !== rect.width || this.size.height !== rect.height) {
			this.size = { width: rect.width, height: rect.height };
		}
		if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
		this.#settleTimer = null;
		if (this.deps.getIsMobile() || this.deps.getSnapshot().fullscreenWindowId) return;
		this.#scheduleFit();
	}

	#scheduleFit(): void {
		this.#settleTimer = setTimeout(async () => {
			this.#settleTimer = null;
			if (
				this.#element &&
				!this.deps.getIsMobile() &&
				!this.deps.getSnapshot().fullscreenWindowId
			) {
				const settled = await this.deps.onResizeSettled();
				if (!settled && this.#element && this.#settleTimer === null) this.#scheduleFit();
			}
		}, WORKSPACE_RESIZE_SETTLE_MS);
	}
}
