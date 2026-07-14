import type { FileSessionRegistry } from '$lib/stores/file-sessions.svelte.js';
import { SerialQueue } from '$lib/utils/serial-queue.js';
import type { ChatInteractionGate } from './chat-interaction-gate.svelte.js';
import {
	fileSurfaceId,
	type HostId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutReader,
} from './surface-types.js';
import type { WorkspaceCommit, WorkspacePublication } from './workspace-commit.js';

interface SurfaceReservations {
	has(surfaceId: string): boolean;
	add(surfaceId: string): unknown;
	delete(surfaceId: string): unknown;
}

interface FileDialogCoordinatorDeps {
	layout: WorkspaceLayoutReader;
	files: FileSessionRegistry;
	chatInteractionGate: ChatInteractionGate;
	reservations: SurfaceReservations;
	commit: WorkspaceCommit;
	isMobile(): boolean;
	responsiveGeneration(): number;
	activeMainId(): string;
	activeSidebarId(): string | null;
	lastFocusedSurfaceId(): string;
	hostOf(surfaceId: string): HostId | null;
	eligibleDesktopReturn(surfaceId: string | null): string | null;
	present(surfaceId: string): void;
	placeOnMobile(
		sessionId: string,
		surfaceId: string,
		publication?: WorkspacePublication,
	): Promise<boolean>;
}

interface DialogOccupantReplacementPlan {
	occupantChangedMessage: string;
	mutations(occupantId: string | null): readonly WorkspaceLayoutMutation[];
	publication?: WorkspacePublication;
	onCurrent(): void;
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

	placeNew(sessionId: string, publication?: WorkspacePublication): Promise<boolean> {
		return this.#queue.enqueue(() =>
			this.#placeNew(sessionId, fileSurfaceId(sessionId), publication),
		);
	}

	pop(surfaceId: string): Promise<boolean> {
		if (this.deps.isMobile() || this.deps.reservations.has(surfaceId)) {
			return Promise.resolve(false);
		}
		this.deps.reservations.add(surfaceId);
		return this.#queue
			.enqueue(() => this.#pop(surfaceId))
			.finally(() => {
				this.deps.reservations.delete(surfaceId);
			});
	}

	moveToHost(destination: HostId): Promise<void> {
		return this.#queue.enqueue(async () => {
			if (this.deps.isMobile()) return;
			const surfaceId = this.deps.layout.snapshot.dialogFileSurfaceId;
			if (!surfaceId || this.deps.reservations.has(surfaceId)) return;
			this.deps.reservations.add(surfaceId);
			try {
				const current = await this.deps.commit((latest) => {
					if (latest.dialogFileSurfaceId !== surfaceId) {
						throw new Error('The dialog occupant changed before it could be moved');
					}
					return [{ type: 'move-dialog-to-host', surfaceId, destination }];
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
	): Promise<boolean> {
		if (this.deps.isMobile()) {
			return this.deps.placeOnMobile(sessionId, surfaceId, publication);
		}
		const responsiveGeneration = this.deps.responsiveGeneration();
		const returnSurfaceId =
			this.deps.eligibleDesktopReturn(this.deps.lastFocusedSurfaceId()) ?? this.deps.activeMainId();
		return this.#replaceDialogOccupant(responsiveGeneration, {
			occupantChangedMessage: 'The dialog occupant changed before replacement',
			mutations: (occupantId) => [
				...(occupantId ? [{ type: 'remove-surface', surfaceId: occupantId } as const] : []),
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
				},
				{ type: 'place-in-dialog', surfaceId },
			],
			publication,
			onCurrent: () => {
				this.#returnSurfaceId = returnSurfaceId;
				this.deps.present(surfaceId);
			},
		});
	}

	async #pop(surfaceId: string): Promise<boolean> {
		if (this.deps.isMobile()) return false;
		const responsiveGeneration = this.deps.responsiveGeneration();
		const sourceHost = this.deps.hostOf(surfaceId);
		const occupantId = this.deps.layout.snapshot.dialogFileSurfaceId;
		if (occupantId === surfaceId) return true;
		return this.#replaceDialogOccupant(responsiveGeneration, {
			occupantChangedMessage: 'The dialog occupant changed before pop out',
			mutations: (currentOccupantId) => [
				...(currentOccupantId
					? [{ type: 'remove-surface', surfaceId: currentOccupantId } as const]
					: []),
				{ type: 'place-in-dialog', surfaceId },
			],
			onCurrent: () => {
				this.#returnSurfaceId =
					sourceHost === 'sidebar' && this.deps.layout.snapshot.sidebarOpen
						? this.deps.activeSidebarId()
						: this.deps.activeMainId();
				this.deps.present(surfaceId);
			},
		});
	}

	async #replaceDialogOccupant(
		responsiveGeneration: number,
		plan: DialogOccupantReplacementPlan,
	): Promise<boolean> {
		const occupantId = this.deps.layout.snapshot.dialogFileSurfaceId;
		const occupant = occupantId ? this.deps.layout.surface(occupantId) : null;
		let occupantSessionId: string | null = null;
		let occupantReserved = false;
		try {
			if (occupant?.type === 'file') {
				this.deps.reservations.add(occupant.id);
				occupantReserved = true;
				const canReplace = await this.deps.files.confirmDestructive(
					occupant.fileSessionId,
					'replace-dialog',
				);
				if (!canReplace || responsiveGeneration !== this.deps.responsiveGeneration()) {
					return false;
				}
				occupantSessionId = occupant.fileSessionId;
			}
			this.deps.chatInteractionGate.cancelBeforeInertTransition();
			const current = await this.deps.commit(
				(latest) => {
					if (latest.dialogFileSurfaceId !== occupantId) {
						throw new Error(plan.occupantChangedMessage);
					}
					return plan.mutations(occupantId);
				},
				{ publication: plan.publication },
			);
			if (occupantSessionId) this.deps.files.destroy(occupantSessionId);
			if (current) plan.onCurrent();
			return true;
		} finally {
			if (occupantReserved && occupantId) this.deps.reservations.delete(occupantId);
		}
	}
}
