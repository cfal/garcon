import type { WorkspaceFiles, WorkspaceSingletons } from './workspace-resource-ports.js';
import type { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import {
	disposeClosedSurface,
	prepareSurfaceClose,
	type SurfaceCloseGuardRequest,
} from './workspace-surface-lifecycle.js';
import type {
	SurfaceDescriptor,
	WorkspaceLayoutReader,
	WorkspaceLayoutSnapshot,
	WorkspaceWindowId,
} from './surface-types.js';
import { workspaceChatViewCount } from './surface-types.js';
import { collectWindowNodes, windowIdOfSurface, windowNodeById } from './window-tree.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';

interface ReservationSet<T> {
	has(value: T): boolean;
	add(value: T): unknown;
	delete(value: T): unknown;
}

interface WorkspaceWindowDestructionServiceDeps {
	layout: WorkspaceLayoutReader;
	files: WorkspaceFiles;
	singletons: WorkspaceSingletons;
	gitMutations?: Pick<GitMutationCoordinator, 'pendingCount'>;
	surfaceReservations: ReservationSet<string>;
	windowReservations: ReservationSet<WorkspaceWindowId>;
	commitDestroyedRemovals(
		surfaceIds: readonly string[],
		plan: WorkspaceMutationPlan,
	): Promise<boolean>;
	confirmClose(request: SurfaceCloseGuardRequest): Promise<boolean>;
	clearAttachmentError(surfaceId: string): void;
	afterTerminalReleased(terminalId: string): Promise<void>;
	onTerminalLauncherDismissed?(): void;
	present(surfaceId: string): void;
}

export class WorkspaceWindowDestructionService {
	constructor(private readonly deps: WorkspaceWindowDestructionServiceDeps) {}

	isSurfaceBlocked(surfaceId: string): boolean {
		if (this.#isSurfaceUnavailable(surfaceId)) return true;
		const snapshot = this.deps.layout.snapshot;
		if (snapshot.surfaces[surfaceId]?.type === 'chat' && workspaceChatViewCount(snapshot) <= 1) {
			return true;
		}
		const ownerWindowId = windowIdOfSurface(snapshot.desktopRoot, surfaceId);
		if (!ownerWindowId) return false;
		if (this.deps.windowReservations.has(ownerWindowId)) return true;
		const owner = windowNodeById(snapshot.desktopRoot, ownerWindowId);
		return owner?.tabs.order.length === 1 && collectWindowNodes(snapshot.desktopRoot).length === 1;
	}

	isWindowBlocked(windowId: WorkspaceWindowId): boolean {
		if (this.deps.windowReservations.has(windowId)) return true;
		const workspaceWindow = windowNodeById(this.deps.layout.snapshot.desktopRoot, windowId);
		if (!workspaceWindow) return true;
		if (this.#removesFinalChat(this.deps.layout.snapshot, [windowId])) return true;
		return workspaceWindow.tabs.order.some((surfaceId) => this.#isSurfaceUnavailable(surfaceId));
	}

	async close(windowId: WorkspaceWindowId): Promise<boolean> {
		return this.#destroy([windowId]);
	}

	isOtherWindowsBlocked(keptWindowId: WorkspaceWindowId): boolean {
		const snapshot = this.deps.layout.snapshot;
		if (!windowNodeById(snapshot.desktopRoot, keptWindowId)) return true;
		const windows = collectWindowNodes(snapshot.desktopRoot);
		const targets = windows.filter((window) => window.id !== keptWindowId);
		if (targets.length === 0) return true;
		if (windows.some((window) => this.deps.windowReservations.has(window.id))) return true;
		const targetWindowIds = targets.map((window) => window.id);
		if (this.#removesFinalChat(snapshot, targetWindowIds)) return true;
		return targets.some((window) => window.tabs.order.some((id) => this.#isSurfaceUnavailable(id)));
	}

	async closeOthers(keptWindowId: WorkspaceWindowId): Promise<boolean> {
		if (this.isOtherWindowsBlocked(keptWindowId)) return false;
		const targetWindowIds = collectWindowNodes(this.deps.layout.snapshot.desktopRoot)
			.filter((window) => window.id !== keptWindowId)
			.map((window) => window.id);
		return this.#destroy(targetWindowIds, keptWindowId);
	}

	async #destroy(
		targetWindowIds: readonly WorkspaceWindowId[],
		focusWindowId?: WorkspaceWindowId,
	): Promise<boolean> {
		const initial = this.deps.layout.snapshot;
		const initialWindows = collectWindowNodes(initial.desktopRoot);
		const targets = initialWindows.filter((window) => targetWindowIds.includes(window.id));
		if (targets.length === 0 || targets.length !== targetWindowIds.length) return false;
		if (this.#removesFinalChat(initial, targetWindowIds)) return false;
		const reservedWindowIds = initialWindows.map((workspaceWindow) => workspaceWindow.id);
		const affectedSurfaceIds = targets.flatMap((window) => window.tabs.order);
		if (
			reservedWindowIds.some((windowId) => this.deps.windowReservations.has(windowId)) ||
			affectedSurfaceIds.some((surfaceId) => this.#isSurfaceUnavailable(surfaceId))
		) {
			return false;
		}
		for (const windowId of reservedWindowIds) this.deps.windowReservations.add(windowId);
		for (const surfaceId of affectedSurfaceIds) this.deps.surfaceReservations.add(surfaceId);
		let removedDescriptors = descriptorsForSurfaces(initial, affectedSurfaceIds);
		let releasedTerminalIds: string[] = [];
		let removalPlanned = false;
		let releaseClose: (() => void) | null = null;
		try {
			releaseClose = await prepareSurfaceClose(this.deps, removedDescriptors);
			if (!releaseClose) return false;
			const plan: WorkspaceMutationPlan = (latest) => {
				removalPlanned = false;
				const latestWindows = collectWindowNodes(latest.desktopRoot);
				const latestTargets = latestWindows.filter((window) => targetWindowIds.includes(window.id));
				if (latestTargets.length !== targetWindowIds.length) return [];
				if (
					latestWindows.some((workspaceWindow) => !reservedWindowIds.includes(workspaceWindow.id))
				) {
					return [];
				}
				const latestAffectedSurfaceIds = latestTargets.flatMap((window) => window.tabs.order);
				if (this.#removesFinalChat(latest, targetWindowIds)) return [];
				if (latestAffectedSurfaceIds.some((surfaceId) => !affectedSurfaceIds.includes(surfaceId))) {
					return [];
				}
				removedDescriptors = descriptorsForSurfaces(latest, latestAffectedSurfaceIds);
				removalPlanned = true;
				return targetWindowIds.map((windowId) => ({ type: 'close-window', windowId }));
			};
			const current = await this.deps.commitDestroyedRemovals(affectedSurfaceIds, plan);
			if (!removalPlanned) return false;
			releasedTerminalIds = removedDescriptors.flatMap((surface) =>
				surface.type === 'terminal' ? [surface.terminalId] : [],
			);
			for (const surface of removedDescriptors) {
				const disposal = disposeClosedSurface(this.deps, surface);
				if (disposal) await disposal;
			}
			if (current) {
				const snapshot = this.deps.layout.snapshot;
				const focusWindow = focusWindowId
					? windowNodeById(snapshot.desktopRoot, focusWindowId)
					: collectWindowNodes(snapshot.desktopRoot)[0];
				if (focusWindow) this.deps.present(focusWindow.tabs.activeId);
			}
			return true;
		} finally {
			releaseClose?.();
			for (const windowId of reservedWindowIds) this.deps.windowReservations.delete(windowId);
			for (const surfaceId of affectedSurfaceIds) this.deps.surfaceReservations.delete(surfaceId);
			for (const terminalId of releasedTerminalIds) {
				await this.deps.afterTerminalReleased(terminalId);
			}
		}
	}

	#removesFinalChat(
		snapshot: WorkspaceLayoutSnapshot,
		windowIds: readonly WorkspaceWindowId[],
	): boolean {
		return !collectWindowNodes(snapshot.desktopRoot).some(
			(window) =>
				!windowIds.includes(window.id) &&
				window.tabs.order.some((id) => snapshot.surfaces[id]?.type === 'chat'),
		);
	}

	#isSurfaceUnavailable(surfaceId: string): boolean {
		if (this.deps.surfaceReservations.has(surfaceId)) return true;
		const surface = this.deps.layout.surface(surfaceId);
		if (!surface) return true;
		if (this.deps.gitMutations?.pendingCount(surfaceId)) return true;
		if (surface.type === 'file') {
			return this.deps.files.get(surface.fileSessionId)?.mutationGuarded ?? false;
		}
		if (surface.type === 'singleton' && surface.kind === 'commit') {
			return !(this.deps.singletons.commitIfPresent()?.canClose ?? true);
		}
		if (surface.type === 'singleton' && surface.kind === 'tickets')
			return this.deps.singletons.ticketsIfPresent()?.drafts.pending ?? false;
		return false;
	}
}

function descriptorsForSurfaces(
	snapshot: WorkspaceLayoutSnapshot,
	surfaceIds: readonly string[],
): SurfaceDescriptor[] {
	return surfaceIds.flatMap((surfaceId) => {
		const surface = snapshot.surfaces[surfaceId];
		return surface ? [surface] : [];
	});
}
