import type {
	FilePlacementResult,
	FileSessionRegistry,
} from '$lib/files/sessions/file-session-registry.svelte.js';
import { SerialQueue } from '$lib/utils/serial-queue.js';
import type { WorkspaceInteractionGate } from './workspace-interaction-gate.svelte.js';
import {
	fileSurfaceId,
	type WorkspaceWindowId,
	type WorkspaceLayoutReader,
} from './surface-types.js';
import { windowNodeById } from './window-tree.js';
import type { WorkspaceCommit, WorkspacePublication } from './workspace-commit.js';

interface SurfaceReservations {
	has(surfaceId: string): boolean;
	add(surfaceId: string): unknown;
	delete(surfaceId: string): unknown;
}

interface FileDialogCoordinatorDeps {
	layout: WorkspaceLayoutReader;
	files: FileSessionRegistry;
	workspaceInteractionGate: WorkspaceInteractionGate;
	reservations: SurfaceReservations;
	commit: WorkspaceCommit;
	isWindowReserved(windowId: WorkspaceWindowId): boolean;
	isMobile(): boolean;
	responsiveGeneration(): number;
	defaultActiveId(): string;
	lastFocusedSurfaceId(): string;
	eligibleDesktopReturn(surfaceId: string | null): string | null;
	present(surfaceId: string): void;
	placeOnMobile(
		sessionId: string,
		surfaceId: string,
		publication?: WorkspacePublication,
	): Promise<FilePlacementResult>;
}

export class FileDialogCoordinator {
	#queue = new SerialQueue();
	#returnSurfaceId: string | null = null;

	constructor(private readonly deps: FileDialogCoordinatorDeps) {}

	get returnSurfaceId(): string | null {
		return this.#returnSurfaceId;
	}

	clearReturnSurface(): void {
		this.#returnSurfaceId = null;
	}

	placeNew(sessionId: string, publication?: WorkspacePublication): Promise<FilePlacementResult> {
		return this.#queue.enqueue(() =>
			this.#placeNew(sessionId, fileSurfaceId(sessionId), publication),
		);
	}

	moveToWindow(destination: WorkspaceWindowId): Promise<void> {
		return this.#queue.enqueue(async () => {
			if (this.deps.isMobile() || this.deps.isWindowReserved(destination)) return;
			const surfaceId = this.deps.layout.snapshot.dialogFileSurfaceId;
			if (!surfaceId || this.deps.reservations.has(surfaceId)) return;
			this.deps.reservations.add(surfaceId);
			try {
				const current = await this.deps.commit((latest) => {
					if (latest.dialogFileSurfaceId !== surfaceId) {
						throw new Error('The dialog occupant changed before it could be moved');
					}
					if (!windowNodeById(latest.desktopRoot, destination)) {
						throw new Error('The destination window is no longer available');
					}
					if (this.deps.isWindowReserved(destination)) return [];
					return [{ type: 'move-dialog-to-window', surfaceId, destinationWindowId: destination }];
				});
				if (!current) return;
				this.#returnSurfaceId = null;
				this.deps.present(surfaceId);
			} finally {
				this.deps.reservations.delete(surfaceId);
			}
		});
	}

	async #placeNew(
		sessionId: string,
		surfaceId: string,
		publication?: WorkspacePublication,
	): Promise<FilePlacementResult> {
		if (this.deps.isMobile()) {
			return this.deps.placeOnMobile(sessionId, surfaceId, publication);
		}
		const responsiveGeneration = this.deps.responsiveGeneration();
		const returnSurfaceId =
			this.deps.eligibleDesktopReturn(this.deps.lastFocusedSurfaceId()) ??
			this.deps.defaultActiveId();
		const occupantId = this.deps.layout.snapshot.dialogFileSurfaceId;
		const occupant = occupantId ? this.deps.layout.surface(occupantId) : null;
		let occupantSessionId: string | null = null;
		let occupantReserved = false;
		let releaseFileClose: (() => void) | null = null;
		try {
			if (occupant?.type === 'file') {
				this.deps.reservations.add(occupant.id);
				occupantReserved = true;
				releaseFileClose = await this.deps.files.prepareDestructiveViews(
					[occupant.fileSessionId],
					'replace-dialog',
				);
				if (!releaseFileClose || responsiveGeneration !== this.deps.responsiveGeneration()) {
					return 'cancelled';
				}
				occupantSessionId = occupant.fileSessionId;
			}
			this.deps.workspaceInteractionGate.cancelBeforeInertTransition();
			const current = await this.deps.commit(
				(latest) => {
					if (latest.dialogFileSurfaceId !== occupantId) {
						throw new Error('The dialog occupant changed before replacement');
					}
					return [
						...(occupantId ? [{ type: 'remove-surface', surfaceId: occupantId } as const] : []),
						{
							type: 'register-surface',
							surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
						},
						{ type: 'place-in-dialog', surfaceId },
					];
				},
				{ publication },
			);
			if (occupantSessionId) await this.deps.files.destroy(occupantSessionId);
			if (current) {
				this.#returnSurfaceId = returnSurfaceId;
				this.deps.present(surfaceId);
			}
			return 'placed';
		} finally {
			releaseFileClose?.();
			if (occupantReserved && occupantId) this.deps.reservations.delete(occupantId);
		}
	}
}
