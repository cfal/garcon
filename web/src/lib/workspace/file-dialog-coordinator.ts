import type { FileSessionRegistry } from '$lib/stores/file-sessions.svelte.js';
import type { ChatInteractionGate } from './chat-interaction-gate.svelte.js';
import { fileSurfaceId, type HostId, type WorkspaceLayoutReader } from './surface-types.js';
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

export class FileDialogCoordinator {
	#tail: Promise<void> = Promise.resolve();
	#returnSurfaceId: string | null = null;

	constructor(private readonly deps: FileDialogCoordinatorDeps) {}

	get returnSurfaceId(): string | null {
		return this.#returnSurfaceId;
	}

	clearReturnSurface(): void {
		this.#returnSurfaceId = null;
	}

	placeNew(sessionId: string, publication?: WorkspacePublication): Promise<boolean> {
		return this.#withTurn(() => this.#placeNew(sessionId, fileSurfaceId(sessionId), publication));
	}

	pop(surfaceId: string): Promise<boolean> {
		if (this.deps.isMobile() || this.deps.reservations.has(surfaceId)) {
			return Promise.resolve(false);
		}
		this.deps.reservations.add(surfaceId);
		return this.#withTurn(() => this.#pop(surfaceId)).finally(() => {
			this.deps.reservations.delete(surfaceId);
		});
	}

	moveToHost(destination: HostId): Promise<void> {
		return this.#withTurn(async () => {
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
		const occupantId = this.deps.layout.snapshot.dialogFileSurfaceId;
		let occupantSessionId: string | null = null;
		if (occupantId) {
			const occupant = this.deps.layout.surface(occupantId);
			if (occupant?.type === 'file') {
				this.deps.reservations.add(occupantId);
				const canReplace = await this.deps.files.confirmDestructive(
					occupant.fileSessionId,
					'replace-dialog',
				);
				if (!canReplace) {
					this.deps.reservations.delete(occupantId);
					return false;
				}
				if (responsiveGeneration !== this.deps.responsiveGeneration()) {
					this.deps.reservations.delete(occupantId);
					return false;
				}
				occupantSessionId = occupant.fileSessionId;
			}
		}
		try {
			this.deps.chatInteractionGate.cancelBeforeInertTransition();
			const current = await this.deps.commit(
				(latest) => {
					if (latest.dialogFileSurfaceId !== occupantId) {
						throw new Error('The dialog occupant changed before replacement');
					}
					return [
						...(occupantId ? [{ type: 'remove-surface', surfaceId: occupantId } as const] : []),
						{
							type: 'register-surface' as const,
							surface: { id: surfaceId, type: 'file' as const, fileSessionId: sessionId },
						},
						{ type: 'place-in-dialog' as const, surfaceId },
					];
				},
				{ publication },
			);
			if (occupantSessionId) this.deps.files.destroy(occupantSessionId);
			if (!current) return true;
			this.#returnSurfaceId = returnSurfaceId;
			this.deps.present(surfaceId);
			return true;
		} finally {
			if (occupantId) this.deps.reservations.delete(occupantId);
		}
	}

	async #pop(surfaceId: string): Promise<boolean> {
		if (this.deps.isMobile()) return false;
		const responsiveGeneration = this.deps.responsiveGeneration();
		const sourceHost = this.deps.hostOf(surfaceId);
		const occupantId = this.deps.layout.snapshot.dialogFileSurfaceId;
		if (occupantId === surfaceId) return true;
		let occupantSessionId: string | null = null;
		if (occupantId) {
			const occupant = this.deps.layout.surface(occupantId);
			if (occupant?.type === 'file') {
				this.deps.reservations.add(occupantId);
				const canReplace = await this.deps.files.confirmDestructive(
					occupant.fileSessionId,
					'replace-dialog',
				);
				if (!canReplace) {
					this.deps.reservations.delete(occupantId);
					return false;
				}
				if (responsiveGeneration !== this.deps.responsiveGeneration()) {
					this.deps.reservations.delete(occupantId);
					return false;
				}
				occupantSessionId = occupant.fileSessionId;
			}
		}
		try {
			this.deps.chatInteractionGate.cancelBeforeInertTransition();
			const current = await this.deps.commit((latest) => {
				if (latest.dialogFileSurfaceId !== occupantId) {
					throw new Error('The dialog occupant changed before pop out');
				}
				return [
					...(occupantId && occupantId !== surfaceId
						? [{ type: 'remove-surface', surfaceId: occupantId } as const]
						: []),
					{ type: 'place-in-dialog' as const, surfaceId },
				];
			});
			if (occupantSessionId) this.deps.files.destroy(occupantSessionId);
			if (!current) return true;
			this.#returnSurfaceId =
				sourceHost === 'sidebar' && this.deps.layout.snapshot.sidebarOpen
					? this.deps.activeSidebarId()
					: this.deps.activeMainId();
			this.deps.present(surfaceId);
			return true;
		} finally {
			if (occupantId) this.deps.reservations.delete(occupantId);
		}
	}

	#withTurn<T>(operation: () => Promise<T>): Promise<T> {
		let resolveResult!: (value: T | PromiseLike<T>) => void;
		let rejectResult!: (reason?: unknown) => void;
		const result = new Promise<T>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const turn = this.#tail.then(operation);
		this.#tail = turn.then(
			() => undefined,
			() => undefined,
		);
		void turn.then(resolveResult, rejectResult);
		return result;
	}
}
