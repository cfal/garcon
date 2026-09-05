import { createRandomId } from '$lib/utils/random-id.js';
import {
	chatViewSurfaceId,
	type WorkspaceLayoutReader,
	type WorkspacePartitionId,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
} from './surface-types.js';
import { windowIdOfSurface, windowNodeById } from './window-tree.js';
import type { WorkspaceCommitOptions, WorkspacePublication } from './workspace-commit.js';
import {
	deferredChatSurfaceTransferPublication,
	type ChatSurfaceTransferPort,
} from './chat-surface-transfer.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';
import type { WorkspaceSplitAdmissionResolver } from './window-geometry-policy.js';
import { requireWorkspaceSplitAdmission } from './workspace-split-blocked-error.js';

interface ReservationSet<T> {
	has(value: T): boolean;
}

interface WorkspaceTabMovementServiceDeps {
	layout: WorkspaceLayoutReader;
	surfaceReservations: ReservationSet<string>;
	windowReservations: ReservationSet<WorkspaceWindowId>;
	isMobile(): boolean;
	cancelWorkspaceDrag(): void;
	commitWithPresentationTarget(
		mutations: WorkspaceMutationPlan,
		resolveTarget: () => string | null,
		options?: WorkspaceCommitOptions,
	): Promise<boolean>;
	resolveSplitAdmission: WorkspaceSplitAdmissionResolver;
	present(surfaceId: string): void;
}

export class WorkspaceTabMovementService {
	#chatSurfaceTransferPort: ChatSurfaceTransferPort | null = null;

	constructor(private readonly deps: WorkspaceTabMovementServiceDeps) {}

	registerChatSurfaceTransferPort(port: ChatSurfaceTransferPort): () => void {
		if (this.#chatSurfaceTransferPort && this.#chatSurfaceTransferPort !== port) {
			throw new Error('A Chat surface transfer port is already registered');
		}
		this.#chatSurfaceTransferPort = port;
		return () => {
			if (this.#chatSurfaceTransferPort === port) this.#chatSurfaceTransferPort = null;
		};
	}

	async moveToWindow(
		surfaceId: string,
		destinationWindowId: WorkspaceWindowId,
		index?: number,
	): Promise<void> {
		if (this.deps.isMobile()) return;
		const initialSourceWindowId = windowIdOfSurface(
			this.deps.layout.snapshot.desktopRoot,
			surfaceId,
		);
		if (
			this.deps.surfaceReservations.has(surfaceId) ||
			(initialSourceWindowId !== null && this.deps.windowReservations.has(initialSourceWindowId)) ||
			this.deps.windowReservations.has(destinationWindowId)
		) {
			return;
		}
		this.deps.cancelWorkspaceDrag();
		let movedSurfaceId: string | null = null;
		let transferPublication: WorkspacePublication | null = null;
		const current = await this.deps.commitWithPresentationTarget(
			(latest) => {
				const surface = latest.surfaces[surfaceId];
				const sourceWindowId = windowIdOfSurface(latest.desktopRoot, surfaceId);
				if (
					!surface ||
					!sourceWindowId ||
					!windowNodeById(latest.desktopRoot, destinationWindowId) ||
					this.deps.surfaceReservations.has(surfaceId) ||
					this.deps.windowReservations.has(sourceWindowId) ||
					this.deps.windowReservations.has(destinationWindowId)
				) {
					return [];
				}
				if (surface.type === 'chat' && sourceWindowId !== destinationWindowId) {
					const destinationSurfaceId = chatViewSurfaceId(destinationWindowId);
					if (!surface.chatId || this.deps.surfaceReservations.has(destinationSurfaceId)) return [];
					movedSurfaceId = destinationSurfaceId;
					transferPublication =
						this.#chatSurfaceTransferPort?.prepareChatSurfaceTransfer({
							sourceSurfaceId: surface.id,
							destinationSurfaceId,
							chatId: surface.chatId,
						}) ?? null;
					return [
						{
							type: 'move-chat-to-window',
							sourceWindowId,
							destinationWindowId,
							index,
						},
					];
				}
				movedSurfaceId = surfaceId;
				return [{ type: 'move-tab', surfaceId, destinationWindowId, index }];
			},
			() => movedSurfaceId,
			{
				publication: deferredChatSurfaceTransferPublication(() => transferPublication),
			},
		);
		if (current && movedSurfaceId && this.deps.layout.surface(movedSurfaceId)) {
			this.deps.present(movedSurfaceId);
		}
	}

	async moveToNewWindow(
		surfaceId: string,
		targetWindowId: WorkspaceWindowId,
		edge: WorkspaceWindowEdge,
	): Promise<void> {
		if (this.deps.isMobile()) return;
		const initialSourceWindowId = windowIdOfSurface(
			this.deps.layout.snapshot.desktopRoot,
			surfaceId,
		);
		if (
			this.deps.surfaceReservations.has(surfaceId) ||
			(initialSourceWindowId !== null && this.deps.windowReservations.has(initialSourceWindowId)) ||
			this.deps.windowReservations.has(targetWindowId)
		) {
			return;
		}
		this.deps.cancelWorkspaceDrag();
		const newWindowId = `window-${createRandomId()}` as WorkspaceWindowId;
		const partitionId = `partition-${createRandomId()}` as WorkspacePartitionId;
		let movedSurfaceId: string | null = null;
		let transferPublication: WorkspacePublication | null = null;
		const current = await this.deps.commitWithPresentationTarget(
			(latest) => {
				const surface = latest.surfaces[surfaceId];
				const sourceWindowId = windowIdOfSurface(latest.desktopRoot, surfaceId);
				if (
					!surface ||
					!sourceWindowId ||
					!windowNodeById(latest.desktopRoot, targetWindowId) ||
					this.deps.surfaceReservations.has(surfaceId) ||
					this.deps.windowReservations.has(sourceWindowId) ||
					this.deps.windowReservations.has(targetWindowId)
				) {
					return [];
				}
				const sourceWindow = windowNodeById(latest.desktopRoot, sourceWindowId);
				if (sourceWindowId === targetWindowId && sourceWindow?.tabs.order.length === 1) {
					return [];
				}
				let movingChatId: string | null = null;
				if (surface.type === 'chat') {
					movingChatId = surface.chatId;
					if (!movingChatId) return [];
				}
				if (
					!requireWorkspaceSplitAdmission(this.deps.resolveSplitAdmission, latest, {
						targetWindowId,
						edge,
						movingSurfaceId: surfaceId,
					})
				) {
					return [];
				}
				if (surface.type === 'chat' && movingChatId) {
					const destinationSurfaceId = chatViewSurfaceId(newWindowId);
					movedSurfaceId = destinationSurfaceId;
					transferPublication =
						this.#chatSurfaceTransferPort?.prepareChatSurfaceTransfer({
							sourceSurfaceId: surface.id,
							destinationSurfaceId,
							chatId: movingChatId,
						}) ?? null;
				} else {
					movedSurfaceId = surfaceId;
				}
				return [
					{
						type: 'move-tab-to-new-window',
						surfaceId,
						targetWindowId,
						edge,
						newWindowId,
						partitionId,
					},
				];
			},
			() => movedSurfaceId,
			{
				publication: deferredChatSurfaceTransferPublication(() => transferPublication),
			},
		);
		if (current && movedSurfaceId && this.deps.layout.surface(movedSurfaceId)) {
			this.deps.present(movedSurfaceId);
		}
	}
}
