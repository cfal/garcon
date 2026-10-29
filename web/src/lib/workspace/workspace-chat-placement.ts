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
import type { WorkspaceCommitOptions, WorkspacePublication } from './workspace-commit.js';
import {
	deferredChatSurfaceTransferPublication,
	type ChatSurfaceTransfer,
} from './chat-surface-transfer.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';
import type {
	WorkspaceLayoutFitResolver,
	WorkspaceSplitAdmissionResolver,
} from './window-geometry-policy.js';
import { requireWorkspaceSplitAdmission } from './workspace-split-blocked-error.js';
import {
	balanceWindowRow,
	collectWindowNodes,
	computeWindowRects,
	windowNodeById,
} from './window-tree.js';
import { reduceWorkspaceLayout } from './workspace-layout.svelte.js';

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
	commit(mutations: WorkspaceMutationPlan): Promise<boolean>;
	commitWithPresentationTarget(
		mutations: WorkspaceMutationPlan,
		resolveTarget: () => string | null,
		options?: WorkspaceCommitOptions,
	): Promise<boolean>;
	prepareChatSurfaceTransfer(transfer: ChatSurfaceTransfer): WorkspacePublication | null;
	resolveSplitAdmission: WorkspaceSplitAdmissionResolver;
	fitsWorkspaceHost: WorkspaceLayoutFitResolver;
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
			return this.#newWindowPlan(latest, chatId, targetWindowId, edge, newWindowId, partitionId);
		});
		return destination.windowId;
	}

	// Anchors on the source chat's window rather than focus, so a fork started from a sidebar
	// menu or a background window still lands next to the chat it branched from. An unplaced
	// source anchors on the last focused window. When no new window fits, the fork replaces the
	// anchor's chat, as it always does in the single mobile presentation.
	async openFork(chatId: string, sourceChatId: string): Promise<ChatViewSurfaceId> {
		const newWindowId = `window-${createRandomId()}` as WorkspaceWindowId;
		const partitionId = `partition-${createRandomId()}` as WorkspacePartitionId;
		const destination = await this.#commitPlacement((latest) => {
			const existing = this.#existingPlacementPlan(latest, chatId);
			if (existing) return existing;
			const anchorWindowId = this.deps.resolveWindowId(
				latest,
				findWorkspaceChatPlacement(latest, sourceChatId)?.windowId ??
					this.deps.lastFocusedWindowId(),
			);
			if (this.deps.isMobile()) {
				return this.#newWindowPlan(
					latest,
					chatId,
					anchorWindowId,
					'right',
					newWindowId,
					partitionId,
				);
			}
			if (this.deps.windowReservations.has(anchorWindowId)) {
				return { destination: null, mutations: [] };
			}
			const opening = this.#forkWindowMutations(
				latest,
				chatId,
				anchorWindowId,
				newWindowId,
				partitionId,
			);
			if (opening) {
				return {
					destination: { surfaceId: chatViewSurfaceId(newWindowId), windowId: newWindowId },
					mutations: opening,
				};
			}
			const replacement = this.#setWindowChatPlan(anchorWindowId, chatId);
			if (!replacement.destination) return replacement;
			// Activation leaves another window's fullscreen, which would otherwise hide the fork.
			return {
				...replacement,
				mutations: [...replacement.mutations, ...this.#activate(replacement.destination)],
			};
		});
		return destination.surfaceId;
	}

	async openBeside(
		chatId: string,
		targetWindowId?: WorkspaceWindowId,
		edge: WorkspaceWindowEdge = 'right',
	): Promise<WorkspaceWindowId> {
		const newWindowId = `window-${createRandomId()}` as WorkspaceWindowId;
		const partitionId = `partition-${createRandomId()}` as WorkspacePartitionId;
		let transferPublication: WorkspacePublication | null = null;
		const destination = await this.#commitPlacement(
			(latest) => {
				transferPublication = null;
				const placement = findWorkspaceChatPlacement(latest, chatId);
				if (!placement) {
					return this.#newWindowPlan(
						latest,
						chatId,
						targetWindowId,
						edge,
						newWindowId,
						partitionId,
					);
				}
				if (this.deps.isMobile()) return this.#existingPlacementPlan(latest, chatId)!;
				const requestedAnchor = targetWindowId ?? this.deps.lastFocusedWindowId();
				if (requestedAnchor && requestedAnchor !== placement.windowId) {
					return this.#existingPlacementPlan(latest, chatId)!;
				}
				const anchorWindowId = this.deps.resolveWindowId(
					latest,
					targetWindowId ?? this.deps.lastFocusedWindowId(),
				);
				const sourceWindow = windowNodeById(latest.desktopRoot, placement.windowId);
				if (!sourceWindow || !this.#isAvailable(placement)) {
					return { destination: null, mutations: [] };
				}
				if (placement.windowId !== anchorWindowId || sourceWindow.tabs.order.length === 1) {
					return this.#existingPlacementPlan(latest, chatId)!;
				}
				if (
					!requireWorkspaceSplitAdmission(this.deps.resolveSplitAdmission, latest, {
						targetWindowId: anchorWindowId,
						edge,
						movingSurfaceId: placement.surfaceId,
					})
				) {
					return { destination: null, mutations: [] };
				}
				const destinationSurfaceId = chatViewSurfaceId(newWindowId);
				transferPublication = this.deps.prepareChatSurfaceTransfer({
					sourceSurfaceId: placement.surfaceId,
					destinationSurfaceId,
					chatId,
				});
				return {
					destination: { surfaceId: destinationSurfaceId, windowId: newWindowId },
					mutations: [
						{
							type: 'move-tab-to-new-window',
							surfaceId: placement.surfaceId,
							targetWindowId: anchorWindowId,
							edge,
							newWindowId,
							partitionId,
						},
					],
				};
			},
			{
				publication: deferredChatSurfaceTransferPublication(() => transferPublication),
			},
		);
		return destination.windowId;
	}

	#newWindowPlan(
		latest: WorkspaceLayoutSnapshot,
		chatId: string,
		targetWindowId: WorkspaceWindowId | undefined,
		edge: WorkspaceWindowEdge,
		newWindowId: WorkspaceWindowId,
		partitionId: WorkspacePartitionId,
	): WorkspaceChatPlacementPlan {
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
	}

	// Prefers halving the source beside it, then adding an equal-width column to the source's row,
	// so forking one of several columns too narrow to halve still adds a column, then halving it
	// below.
	#forkWindowMutations(
		latest: WorkspaceLayoutSnapshot,
		chatId: string,
		anchorWindowId: WorkspaceWindowId,
		newWindowId: WorkspaceWindowId,
		partitionId: WorkspacePartitionId,
	): WorkspaceLayoutMutation[] | null {
		const open = (edge: WorkspaceWindowEdge): WorkspaceLayoutMutation => ({
			type: 'open-chat-in-new-window',
			chatId,
			targetWindowId: anchorWindowId,
			edge,
			newWindowId,
			partitionId,
		});
		const admission = (edge: WorkspaceWindowEdge) =>
			this.deps.resolveSplitAdmission(latest, { targetWindowId: anchorWindowId, edge });
		const beside = admission('right');
		if (beside?.allowed) return [open('right')];
		if (beside?.reason === 'too-small') {
			const ratios = this.#balancedRowRatios(latest, open('right'), newWindowId);
			if (ratios) return [open('right'), ...ratios];
		}
		return admission('bottom')?.allowed ? [open('bottom')] : null;
	}

	#balancedRowRatios(
		latest: WorkspaceLayoutSnapshot,
		opening: WorkspaceLayoutMutation,
		newWindowId: WorkspaceWindowId,
	): WorkspaceLayoutMutation[] | null {
		const opened = reduceWorkspaceLayout(latest, [opening]).desktopRoot;
		const balanced = balanceWindowRow(opened, newWindowId);
		if (!balanced || !this.deps.fitsWorkspaceHost(balanced)) return null;
		const openedRatios = new Map(
			computeWindowRects(opened).partitions.map(({ partition }) => [partition.id, partition.ratio]),
		);
		return computeWindowRects(balanced)
			.partitions.filter(({ partition }) => openedRatios.get(partition.id) !== partition.ratio)
			.map(({ partition }) => ({
				type: 'set-partition-ratio',
				partitionId: partition.id,
				ratio: partition.ratio,
			}));
	}

	async clearDeletedChat(chatId: string): Promise<void> {
		await this.deps.commit((latest) =>
			collectWindowNodes(latest.desktopRoot).flatMap((workspaceWindow) => {
				const surfaceId = chatViewSurfaceId(workspaceWindow.id);
				const surface = latest.surfaces[surfaceId];
				return surface?.type === 'chat' && surface.chatId === chatId
					? [{ type: 'set-window-chat' as const, windowId: workspaceWindow.id, chatId: null }]
					: [];
			}),
		);
	}

	async #show(
		chatId: string,
		resolveWindow: (snapshot: WorkspaceLayoutSnapshot) => WorkspaceWindowId | null,
	): Promise<ChatViewSurfaceId> {
		const destination = await this.#commitPlacement((latest) => {
			const existing = this.#existingPlacementPlan(latest, chatId);
			if (existing) return existing;
			const windowId = resolveWindow(latest);
			return windowId
				? this.#setWindowChatPlan(windowId, chatId)
				: { destination: null, mutations: [] };
		});
		return destination.surfaceId;
	}

	#setWindowChatPlan(windowId: WorkspaceWindowId, chatId: string): WorkspaceChatPlacementPlan {
		if (this.deps.windowReservations.has(windowId)) return { destination: null, mutations: [] };
		const surfaceId = chatViewSurfaceId(windowId);
		if (this.deps.surfaceReservations.has(surfaceId)) return { destination: null, mutations: [] };
		const mutations: WorkspaceLayoutMutation[] = [{ type: 'set-window-chat', windowId, chatId }];
		if (this.deps.isMobile()) {
			mutations.push({
				type: 'set-mobile-presentation',
				activeId: surfaceId,
				returnStack: [],
			});
		}
		return { destination: { surfaceId, windowId }, mutations };
	}

	async #commitPlacement(
		resolvePlan: (snapshot: WorkspaceLayoutSnapshot) => WorkspaceChatPlacementPlan,
		options?: WorkspaceCommitOptions,
	): Promise<WorkspaceChatPlacement> {
		let plan: WorkspaceChatPlacementPlan = { destination: null, mutations: [] };
		const stillCurrent = await this.deps.commitWithPresentationTarget(
			(latest) => {
				plan = resolvePlan(latest);
				return plan.mutations;
			},
			() => plan.destination?.surfaceId ?? null,
			options,
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
