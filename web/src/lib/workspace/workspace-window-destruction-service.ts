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
import { collectWindowNodes, windowNodeById } from './window-tree.js';
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

export type WorkspaceWindowDestructionMode = 'close' | 'fullscreen';

export class WorkspaceWindowDestructionService {
	constructor(private readonly deps: WorkspaceWindowDestructionServiceDeps) {}

	isWindowBlocked(windowId: WorkspaceWindowId): boolean {
		if (this.deps.windowReservations.has(windowId)) return true;
		const workspaceWindow = windowNodeById(this.deps.layout.snapshot.desktopRoot, windowId);
		if (!workspaceWindow) return true;
		return workspaceWindow.tabs.order.some((surfaceId) => this.#isSurfaceBlocked(surfaceId));
	}

	async close(windowId: WorkspaceWindowId): Promise<boolean> {
		return this.#destroy('close', windowId);
	}

	async fullscreen(windowId: WorkspaceWindowId): Promise<boolean> {
		return this.#destroy('fullscreen', windowId);
	}

	async #destroy(
		mode: WorkspaceWindowDestructionMode,
		targetWindowId: WorkspaceWindowId,
	): Promise<boolean> {
		const initial = this.deps.layout.snapshot;
		const target = windowNodeById(initial.desktopRoot, targetWindowId);
		if (!target) return false;
		const initialWindows = collectWindowNodes(initial.desktopRoot);
		if (mode === 'close' && initialWindows.length === 1) return false;
		const affectedWindows =
			mode === 'close'
				? [target]
				: initialWindows.filter((workspaceWindow) => workspaceWindow.id !== targetWindowId);
		const reservedWindowIds = initialWindows.map((workspaceWindow) => workspaceWindow.id);
		const affectedSurfaceIds = affectedWindows.flatMap(
			(workspaceWindow) => workspaceWindow.tabs.order,
		);
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
				const latestTarget = windowNodeById(latest.desktopRoot, targetWindowId);
				if (!latestTarget) return [];
				const latestWindows = collectWindowNodes(latest.desktopRoot);
				if (
					latestWindows.some((workspaceWindow) => !reservedWindowIds.includes(workspaceWindow.id))
				) {
					return [];
				}
				const latestAffected =
					mode === 'close'
						? [latestTarget]
						: latestWindows.filter((workspaceWindow) => workspaceWindow.id !== targetWindowId);
				const latestAffectedSurfaceIds = latestAffected.flatMap(
					(workspaceWindow) => workspaceWindow.tabs.order,
				);
				if (latestAffectedSurfaceIds.some((surfaceId) => !affectedSurfaceIds.includes(surfaceId))) {
					return [];
				}
				removedDescriptors = latestAffected.flatMap((workspaceWindow) =>
					workspaceWindow.tabs.order.flatMap((surfaceId) => {
						const surface = latest.surfaces[surfaceId];
						return surface ? [surface] : [];
					}),
				);
				if (mode === 'close') {
					if (latestWindows.length === 1) return [];
					removalPlanned = true;
					return [{ type: 'close-window', windowId: targetWindowId }];
				}
				removalPlanned = true;
				return [{ type: 'retain-only-window', windowId: targetWindowId }];
			};
			const current = await this.deps.commitDestroyedRemovals(affectedSurfaceIds, plan);
			if (!removalPlanned) return false;
			releasedTerminalIds = removedDescriptors.flatMap((surface) =>
				surface.type === 'terminal' ? [surface.terminalId] : [],
			);
			await this.#disposeRemovedDescriptors(removedDescriptors);
			if (current) {
				const snapshot = this.deps.layout.snapshot;
				const focusWindow =
					mode === 'fullscreen'
						? windowNodeById(snapshot.desktopRoot, targetWindowId)
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
