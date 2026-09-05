import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import type { SingletonSurfaceRegistry } from './singleton-surfaces.svelte.js';
import * as m from '$lib/paraglide/messages.js';
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

interface CloseGuardRequest {
	surfaceId: string;
	title: string;
	description: string;
	confirmLabel: string;
}

interface WorkspaceWindowDestructionServiceDeps {
	layout: WorkspaceLayoutReader;
	files: FileSessionRegistry;
	singletons: SingletonSurfaceRegistry;
	gitMutations?: GitMutationCoordinator;
	surfaceReservations: ReservationSet<string>;
	windowReservations: ReservationSet<WorkspaceWindowId>;
	commitDestroyedRemovals(
		surfaceIds: readonly string[],
		plan: WorkspaceMutationPlan,
	): Promise<boolean>;
	confirmClose(request: CloseGuardRequest): Promise<boolean>;
	clearAttachmentError(surfaceId: string): void;
	afterTerminalReleased(terminalId: string): Promise<void>;
	onTerminalLauncherDismissed?(): void;
	present(surfaceId: string): void;
}

export class WorkspaceWindowDestructionService {
	constructor(private readonly deps: WorkspaceWindowDestructionServiceDeps) {}

	isSurfaceBlocked(surfaceId: string): boolean {
		if (this.#isSurfaceBlocked(surfaceId)) return true;
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
		return workspaceWindow.tabs.order.some((surfaceId) => this.#isSurfaceBlocked(surfaceId));
	}

	async close(windowId: WorkspaceWindowId): Promise<boolean> {
		return this.#destroy([windowId]);
	}

	isOtherWindowsBlocked(keptWindowId: WorkspaceWindowId): boolean {
		const snapshot = this.deps.layout.snapshot;
		if (!windowNodeById(snapshot.desktopRoot, keptWindowId)) return true;
		const windows = collectWindowNodes(snapshot.desktopRoot);
		const targets = windows.filter((window) => window.id !== keptWindowId);
		return (
			targets.length === 0 ||
			windows.some((window) => this.deps.windowReservations.has(window.id)) ||
			this.#removesFinalChat(
				snapshot,
				targets.map((window) => window.id),
			) ||
			targets.some((window) => window.tabs.order.some((id) => this.#isSurfaceBlocked(id)))
		);
	}

	async closeOthers(keptWindowId: WorkspaceWindowId): Promise<boolean> {
		if (this.isOtherWindowsBlocked(keptWindowId)) return false;
		const targets = collectWindowNodes(this.deps.layout.snapshot.desktopRoot)
			.filter((window) => window.id !== keptWindowId)
			.map((window) => window.id);
		return this.#destroy(targets, keptWindowId);
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
			affectedSurfaceIds.some((surfaceId) => this.#isSurfaceBlocked(surfaceId))
		) {
			return false;
		}
		for (const windowId of reservedWindowIds) this.deps.windowReservations.add(windowId);
		for (const surfaceId of affectedSurfaceIds) this.deps.surfaceReservations.add(surfaceId);
		let removedDescriptors: SurfaceDescriptor[] = affectedSurfaceIds.flatMap((surfaceId) => {
			const surface = initial.surfaces[surfaceId];
			return surface ? [surface] : [];
		});
		let releasedTerminalIds: string[] = [];
		let removalPlanned = false;
		try {
			if (!(await this.#confirmDestruction(removedDescriptors))) return false;
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
				removedDescriptors = latestAffectedSurfaceIds.flatMap((surfaceId) => {
					const surface = latest.surfaces[surfaceId];
					return surface ? [surface] : [];
				});
				removalPlanned = true;
				return targetWindowIds.map((windowId) => ({ type: 'close-window', windowId }));
			};
			const current = await this.deps.commitDestroyedRemovals(affectedSurfaceIds, plan);
			if (!removalPlanned) return false;
			releasedTerminalIds = removedDescriptors.flatMap((surface) =>
				surface.type === 'terminal' ? [surface.terminalId] : [],
			);
			await this.#disposeRemovedDescriptors(removedDescriptors);
			if (current) {
				const snapshot = this.deps.layout.snapshot;
				const focusWindow = focusWindowId
					? windowNodeById(snapshot.desktopRoot, focusWindowId)
					: collectWindowNodes(snapshot.desktopRoot)[0];
				if (focusWindow) this.deps.present(focusWindow.tabs.activeId);
			}
			return true;
		} finally {
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

	#isSurfaceBlocked(surfaceId: string): boolean {
		if (this.deps.surfaceReservations.has(surfaceId)) return true;
		const surface = this.deps.layout.surface(surfaceId);
		if (!surface) return true;
		if (this.deps.gitMutations?.pendingCount(surfaceId)) return true;
		if (surface.type === 'file') {
			return (this.deps.files.get(surface.fileSessionId)?.pendingMutationCount ?? 0) > 0;
		}
		if (surface.type === 'singleton' && surface.kind === 'commit') {
			return !(this.deps.singletons.commitIfPresent()?.canClose ?? true);
		}
		return false;
	}

	async #confirmDestruction(descriptors: readonly SurfaceDescriptor[]): Promise<boolean> {
		const commit = descriptors.find(
			(surface): surface is Extract<SurfaceDescriptor, { type: 'singleton'; kind: 'commit' }> =>
				surface.type === 'singleton' && surface.kind === 'commit',
		);
		if (commit) {
			const controller = this.deps.singletons.commitIfPresent();
			if (controller && !controller.canClose) return false;
			const draftCount = controller?.retainedDraftCount ?? 0;
			if (
				draftCount > 0 &&
				!(await this.deps.confirmClose({
					surfaceId: commit.id,
					title: m.commit_surface_close_title(),
					description:
						draftCount === 1
							? m.commit_surface_close_drafts_singular()
							: m.commit_surface_close_drafts_plural({ count: draftCount }),
					confirmLabel: m.commit_surface_discard_close(),
				}))
			) {
				return false;
			}
		}
		for (const surface of descriptors) {
			if (surface.type !== 'file') continue;
			if (!(await this.deps.files.confirmDestructive(surface.fileSessionId, 'close'))) return false;
		}
		return true;
	}

	async #disposeRemovedDescriptors(descriptors: readonly SurfaceDescriptor[]): Promise<void> {
		for (const surface of descriptors) {
			this.deps.clearAttachmentError(surface.id);
			if (surface.type === 'file') {
				this.deps.files.destroy(surface.fileSessionId);
				continue;
			}
			if (surface.type === 'terminal') continue;
			if (surface.type === 'terminal-launcher') {
				this.deps.onTerminalLauncherDismissed?.();
				continue;
			}
			if (surface.type === 'singleton') {
				if (surface.kind === 'commit') {
					this.deps.singletons.commitIfPresent()?.discardDrafts();
				}
				this.deps.singletons.disposeSurface(surface.kind);
			}
		}
	}
}

export function workspaceWindowSurfaceIds(
	snapshot: WorkspaceLayoutSnapshot,
	windowId: WorkspaceWindowId,
): readonly string[] {
	return windowNodeById(snapshot.desktopRoot, windowId)?.tabs.order ?? [];
}
