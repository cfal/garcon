import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { WorkspaceLayoutSnapshot, WorkspaceWindowId } from './surface-types.js';
import { resolveWorkspaceCompactActive, type WorkspaceHostSize } from './window-geometry-policy.js';

interface WorkspaceHostGeometryStateDeps {
	getSnapshot(): WorkspaceLayoutSnapshot;
	getIsMobile(): boolean;
	beforeCompactProjection(): void;
	onCompactProjectionChanged(active: boolean): void;
}

export class WorkspaceHostGeometryState {
	size = $state.raw<WorkspaceHostSize | null>(null);
	#compact = $state(false);
	#awaitingTiledMeasurement = $state(false);
	#compactSession = $state(0);
	#element: HTMLElement | null = null;
	#measureFrame: number | null = null;
	#lastFullscreenWindowId: WorkspaceWindowId | null;
	#lastIsMobile: boolean;

	constructor(private readonly deps: WorkspaceHostGeometryStateDeps) {
		this.#lastFullscreenWindowId = deps.getSnapshot().fullscreenWindowId;
		this.#lastIsMobile = deps.getIsMobile();
	}

	get compactActive(): boolean {
		return !this.deps.getIsMobile() && this.#compact;
	}

	get singleWindowProjectionActive(): boolean {
		return !this.deps.getIsMobile() && (this.#compact || this.#awaitingTiledMeasurement);
	}

	get compactSession(): number {
		return this.#compactSession;
	}

	readonly attach: Attachment<HTMLElement> = (element) =>
		untrack(() => {
			this.#element = element;
			this.#measure();
			const observer = new ResizeObserver(() => this.#scheduleMeasure());
			observer.observe(element);
			return () => {
				observer.disconnect();
				if (this.#measureFrame !== null) cancelAnimationFrame(this.#measureFrame);
				this.#measureFrame = null;
				this.#setCompact(false);
				this.#element = null;
				this.size = null;
				this.#awaitingTiledMeasurement = false;
			};
		});

	layoutPublished(snapshot: WorkspaceLayoutSnapshot): void {
		const isMobile = this.deps.getIsMobile();
		const returnedToDesktop = this.#lastIsMobile && !isMobile;
		this.#lastIsMobile = isMobile;
		const exitedFullscreen =
			this.#lastFullscreenWindowId !== null && snapshot.fullscreenWindowId === null;
		this.#lastFullscreenWindowId = snapshot.fullscreenWindowId;

		if (returnedToDesktop || exitedFullscreen) {
			this.#beginTiledMeasurementHold();
			this.#scheduleMeasure();
			return;
		}
		if (!isMobile && !snapshot.fullscreenWindowId) this.#reconcile(snapshot);
	}

	#scheduleMeasure(): void {
		if (!this.#element || this.#measureFrame !== null) return;
		this.#measureFrame = requestAnimationFrame(() => {
			this.#measureFrame = null;
			this.#measure();
		});
	}

	#measure(): void {
		const element = this.#element;
		if (!element) return;
		const rect = element.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const previous = this.size;
		if (!previous || previous.width !== rect.width || previous.height !== rect.height) {
			this.size = { width: rect.width, height: rect.height };
		}
		const snapshot = this.deps.getSnapshot();
		if (this.deps.getIsMobile() || snapshot.fullscreenWindowId) return;
		this.#reconcile(snapshot);
		this.#awaitingTiledMeasurement = false;
	}

	#reconcile(snapshot: WorkspaceLayoutSnapshot): void {
		this.#setCompact(
			resolveWorkspaceCompactActive({
				wasActive: this.#compact,
				root: snapshot.desktopRoot,
				hostSize: this.size,
			}),
		);
	}

	#beginTiledMeasurementHold(): void {
		if (!this.#compact && !this.#awaitingTiledMeasurement) {
			this.deps.beforeCompactProjection();
		}
		this.#awaitingTiledMeasurement = true;
	}

	#setCompact(next: boolean): void {
		if (next === this.#compact) return;
		if (next) {
			if (!this.#awaitingTiledMeasurement) this.deps.beforeCompactProjection();
			this.#compactSession += 1;
		}
		this.#compact = next;
		this.deps.onCompactProjectionChanged(next);
	}
}
