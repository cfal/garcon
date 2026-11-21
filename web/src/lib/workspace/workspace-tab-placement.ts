import * as m from '$lib/paraglide/messages.js';
import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
import {
	portableSingletonDescriptor,
	singletonSurfaceId,
	type PortableSingletonKind,
	type WorkflowSurfaceDescriptor,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowId,
} from './surface-types.js';
import { windowIdOfSurface, windowNodeById } from './window-tree.js';
import type { WorkspacePresentationController } from './workspace-presentation-controller.svelte.js';

interface WorkspaceTabPlacementDeps {
	presentation: Pick<
		WorkspacePresentationController,
		| 'commit'
		| 'commitWithPresentationTarget'
		| 'focusMobileSingleton'
		| 'isMobile'
		| 'layout'
		| 'presentSurface'
		| 'returnStackForTransient'
	>;
	surfaceReservations: ReadonlySet<string>;
	windowReservations: ReadonlySet<WorkspaceWindowId>;
	resolveWindowId(
		snapshot: WorkspaceLayoutSnapshot,
		preferred: WorkspaceWindowId,
	): WorkspaceWindowId;
	cancelDrag(): void;
}

export class WorkspaceTabPlacementService {
	constructor(private readonly deps: WorkspaceTabPlacementDeps) {}

	openNewWorkflow(
		context: WorkflowLaunchContext | null,
		windowId: WorkspaceWindowId,
	): Promise<void> {
		return this.#openWorkflowSurface(
			{ id: 'new-workflow', type: 'new-workflow', context },
			windowId,
		);
	}

	openWorkflowRun(runId: string, windowId: WorkspaceWindowId): Promise<void> {
		return this.#openWorkflowSurface({ id: 'workflow-run', type: 'workflow-run', runId }, windowId);
	}

	async #openWorkflowSurface(
		surface: WorkflowSurfaceDescriptor,
		preferredWindowId: WorkspaceWindowId,
	): Promise<void> {
		const { presentation, surfaceReservations, windowReservations } = this.deps;
		this.deps.cancelDrag();
		let target: string | null = null;
		const current = await presentation.commitWithPresentationTarget(
			(latest) => {
				const windowId =
					windowIdOfSurface(latest.desktopRoot, surface.id) ??
					this.deps.resolveWindowId(latest, preferredWindowId);
				if (windowReservations.has(windowId) || surfaceReservations.has(surface.id)) return [];
				target = surface.id;
				const previous = latest.surfaces[surface.id];
				const mutations: WorkspaceLayoutMutation[] = [];
				if (!previous) mutations.push({ type: 'register-surface', surface, windowId });
				else if (
					previous.type === 'workflow-run' &&
					surface.type === 'workflow-run' &&
					previous.runId !== surface.runId
				) {
					mutations.push({ type: 'replace-surface', previousId: previous.id, surface });
				}
				mutations.push({ type: 'activate-window-tab', windowId, surfaceId: surface.id });
				if (presentation.isMobile) {
					mutations.push({
						type: 'set-mobile-presentation',
						activeId: surface.id,
						returnStack: presentation.returnStackForTransient(surface.id),
					});
				}
				return mutations;
			},
			() => target,
		);
		if (!target) throw new Error(m.workspace_open_failed());
		if (current) presentation.presentSurface(target);
	}

	async openSingletonAsTab(
		kind: PortableSingletonKind,
		windowId: WorkspaceWindowId,
	): Promise<void> {
		const { presentation, surfaceReservations, windowReservations } = this.deps;
		const surfaceId = singletonSurfaceId(kind);
		if (surfaceReservations.has(surfaceId)) return;
		if (presentation.isMobile) {
			await presentation.focusMobileSingleton(kind);
			return;
		}
		this.deps.cancelDrag();
		const current = await presentation.commit((latest) => {
			if (!windowNodeById(latest.desktopRoot, windowId) || windowReservations.has(windowId)) {
				return [];
			}
			const existingWindowId = windowIdOfSurface(latest.desktopRoot, surfaceId);
			if (existingWindowId === windowId) {
				return [{ type: 'activate-window-tab', windowId, surfaceId }];
			}
			if (latest.surfaces[surfaceId]) {
				return [{ type: 'move-tab', surfaceId, destinationWindowId: windowId }];
			}
			return [
				{ type: 'register-surface', surface: portableSingletonDescriptor(kind), windowId },
				{ type: 'activate-window-tab', windowId, surfaceId },
			];
		});
		if (current && presentation.layout.surface(surfaceId)) presentation.presentSurface(surfaceId);
	}
}
