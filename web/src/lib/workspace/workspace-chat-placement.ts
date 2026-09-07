import * as m from '$lib/paraglide/messages.js';
import { createRandomId } from '$lib/utils/random-id.js';
import {
	chatViewSurfaceId,
	type ChatViewSurfaceId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
	type WorkspacePartitionId,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
} from './surface-types.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';
import type { WorkspaceSplitAdmissionResolver } from './window-geometry-policy.js';
import { requireWorkspaceSplitAdmission } from './workspace-split-blocked-error.js';
import { collectWindowNodes, windowNodeById } from './window-tree.js';

export interface WorkspaceChatPlacement {
	surfaceId: ChatViewSurfaceId;
	windowId: WorkspaceWindowId;
}

export function findWorkspaceChatPlacement(
	snapshot: Pick<WorkspaceLayoutSnapshot, 'desktopRoot' | 'surfaces'>,
	chatId: string,
): WorkspaceChatPlacement | null {
	for (const workspaceWindow of collectWindowNodes(snapshot.desktopRoot)) {
		for (const surfaceId of workspaceWindow.tabs.order) {
			const surface = snapshot.surfaces[surfaceId];
			if (surface?.type !== 'chat' || surface.chatId !== chatId) continue;
			return { surfaceId: surface.id, windowId: workspaceWindow.id };
		}
	}
	return null;
}

interface ReservationSet<T> {
	has(value: T): boolean;
}

interface WorkspaceChatPlacementServiceDeps {
	surfaceReservations: ReservationSet<string>;
	windowReservations: ReservationSet<WorkspaceWindowId>;
	isMobile(): boolean;
	lastFocusedWindowId(): WorkspaceWindowId | null;
	resolveWindowId(
		snapshot: WorkspaceLayoutSnapshot,
		preferredWindowId: WorkspaceWindowId | null | undefined,
	): WorkspaceWindowId;
	commitWithPresentationTarget(
		mutations: WorkspaceMutationPlan,
		resolveTarget: () => string | null,
	): Promise<boolean>;
	resolveSplitAdmission: WorkspaceSplitAdmissionResolver;
	present(surfaceId: string): void;
}

interface WorkspaceChatPlacementPlan {
	destination: WorkspaceChatPlacement | null;
	mutations: readonly WorkspaceLayoutMutation[];
}

export class WorkspaceChatPlacementService {
	constructor(private readonly deps: WorkspaceChatPlacementServiceDeps) {}

	showInCurrentWindow(
		chatId: string,
		intendedWindowId: WorkspaceWindowId,
	): Promise<ChatViewSurfaceId> {
		return this.#show(chatId, (latest) =>
			windowNodeById(latest.desktopRoot, intendedWindowId)
				? intendedWindowId
				: this.deps.resolveWindowId(latest, this.deps.lastFocusedWindowId()),
		);
	}

	showInWindow(chatId: string, windowId: WorkspaceWindowId): Promise<ChatViewSurfaceId> {
		return this.#show(chatId, (latest) =>
			windowNodeById(latest.desktopRoot, windowId) ? windowId : null,
		);
	}

	async openInNewWindow(
		chatId: string,
		targetWindowId?: WorkspaceWindowId,
		edge: WorkspaceWindowEdge = 'right',
	): Promise<WorkspaceWindowId> {
		const newWindowId = `window-${createRandomId()}` as WorkspaceWindowId;
		const partitionId = `partition-${createRandomId()}` as WorkspacePartitionId;
		const destination = await this.#commitPlacement((latest) => {
			const existing = this.#existingPlacementPlan(latest, chatId);
			if (existing) return existing;

			const anchorWindowId = this.deps.resolveWindowId(
				latest,
				targetWindowId ?? this.deps.lastFocusedWindowId(),
			);
			if (this.deps.windowReservations.has(anchorWindowId)) {
				return { destination: null, mutations: [] };
			}
			if (this.deps.isMobile()) {
				const surfaceId = chatViewSurfaceId(anchorWindowId);
				if (this.deps.surfaceReservations.has(surfaceId)) {
					return { destination: null, mutations: [] };
				}
				return {
					destination: { surfaceId, windowId: anchorWindowId },
					mutations: [
						{ type: 'set-window-chat', windowId: anchorWindowId, chatId },
						{ type: 'set-mobile-presentation', activeId: surfaceId, returnStack: [] },
					],
				};
			}

			if (
				!requireWorkspaceSplitAdmission(this.deps.resolveSplitAdmission, latest, {
					targetWindowId: anchorWindowId,
					edge,
				})
			) {
				return { destination: null, mutations: [] };
			}
			const surfaceId = chatViewSurfaceId(newWindowId);
			return {
				destination: { surfaceId, windowId: newWindowId },
				mutations: [
					{
						type: 'open-chat-in-new-window',
						chatId,
						targetWindowId: anchorWindowId,
						edge,
						newWindowId,
						partitionId,
					},
				],
			};
		});
		return destination.windowId;
	}

	async #show(
		chatId: string,
		resolveWindow: (snapshot: WorkspaceLayoutSnapshot) => WorkspaceWindowId | null,
	): Promise<ChatViewSurfaceId> {
		const destination = await this.#commitPlacement((latest) => {
			const existing = this.#existingPlacementPlan(latest, chatId);
			if (existing) return existing;

			const windowId = resolveWindow(latest);
			if (!windowId || this.deps.windowReservations.has(windowId)) {
				return { destination: null, mutations: [] };
			}
			const surfaceId = chatViewSurfaceId(windowId);
			if (this.deps.surfaceReservations.has(surfaceId)) {
				return { destination: null, mutations: [] };
			}
			const mutations: WorkspaceLayoutMutation[] = [
				{ type: 'set-window-chat', windowId, chatId },
			];
			if (this.deps.isMobile()) {
				mutations.push({
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack: [],
				});
			}
			return { destination: { surfaceId, windowId }, mutations };
		});
		return destination.surfaceId;
	}

	async #commitPlacement(
		resolvePlan: (snapshot: WorkspaceLayoutSnapshot) => WorkspaceChatPlacementPlan,
	): Promise<WorkspaceChatPlacement> {
		let plan: WorkspaceChatPlacementPlan = { destination: null, mutations: [] };
		const stillCurrent = await this.deps.commitWithPresentationTarget(
			(latest) => {
				plan = resolvePlan(latest);
				return plan.mutations;
			},
			() => plan.destination?.surfaceId ?? null,
		);
		const destination = plan.destination;
		if (!destination) throw new Error(m.workspace_open_failed());
		if (stillCurrent) this.deps.present(destination.surfaceId);
		return destination;
	}

	#existingPlacementPlan(
		snapshot: WorkspaceLayoutSnapshot,
		chatId: string,
	): WorkspaceChatPlacementPlan | null {
		const placement = findWorkspaceChatPlacement(snapshot, chatId);
		if (!placement) return null;
		if (!this.#isAvailable(placement)) return { destination: null, mutations: [] };
		return { destination: placement, mutations: this.#activate(placement) };
	}

	#activate(placement: WorkspaceChatPlacement): WorkspaceLayoutMutation[] {
		const mutations: WorkspaceLayoutMutation[] = [
			{
				type: 'activate-window-tab',
				windowId: placement.windowId,
				surfaceId: placement.surfaceId,
			},
		];
		if (this.deps.isMobile()) {
			mutations.push({
				type: 'set-mobile-presentation',
				activeId: placement.surfaceId,
				returnStack: [],
			});
		}
		return mutations;
	}

	#isAvailable(placement: WorkspaceChatPlacement): boolean {
		return (
			!this.deps.windowReservations.has(placement.windowId) &&
			!this.deps.surfaceReservations.has(placement.surfaceId)
		);
	}
}
