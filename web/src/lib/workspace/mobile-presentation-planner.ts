import { planDesktopReturnMutations } from './responsive-handoff.js';
import type {
	MobileReturnTarget,
	WorkspaceLayoutMutation,
	WorkspaceLayoutSnapshot,
} from './surface-types.js';
import { collectWindowNodes } from './window-tree.js';

interface MobileWorkspaceContext {
	chatId: string;
	effectiveProjectKey: string | null;
}

interface MobilePresentationPlannerDeps {
	getContext(): MobileWorkspaceContext | null;
	getRouteIdentity(): string;
}

export interface MobileReturnPlan {
	activeId: string;
	returnStack: readonly MobileReturnTarget[];
}

export class MobilePresentationPlanner {
	#mostRecentSurfaceIds: string[] = [];

	constructor(private readonly deps: MobilePresentationPlannerDeps) {}

	returnStackForTransient(
		nextSurfaceId: string,
		snapshot: WorkspaceLayoutSnapshot,
		isMobile: boolean,
	): readonly MobileReturnTarget[] {
		if (!isMobile || snapshot.mobileActiveSurfaceId === nextSurfaceId) {
			return snapshot.mobileReturnStack;
		}
		const context = this.deps.getContext();
		return [
			...snapshot.mobileReturnStack,
			{
				invokerSurfaceId: snapshot.mobileActiveSurfaceId,
				invokerHost: 'mobile',
				chatId: context?.chatId ?? null,
				effectiveProjectKey: context?.effectiveProjectKey ?? null,
				routeIdentity: this.deps.getRouteIdentity(),
			},
		];
	}

	resolveReturn(
		excluding: string | ReadonlySet<string>,
		snapshot: WorkspaceLayoutSnapshot,
		sourceSnapshot: WorkspaceLayoutSnapshot = snapshot,
	): MobileReturnPlan {
		const context = this.deps.getContext();
		const routeIdentity = this.deps.getRouteIdentity();
		const isExcluded = (surfaceId: string): boolean =>
			typeof excluding === 'string' ? surfaceId === excluding : excluding.has(surfaceId);
		const isAvailable = (surfaceId: string): boolean =>
			!isExcluded(surfaceId) && Boolean(snapshot.surfaces[surfaceId]);
		for (let index = snapshot.mobileReturnStack.length - 1; index >= 0; index -= 1) {
			const target = snapshot.mobileReturnStack[index];
			if (
				!isExcluded(target.invokerSurfaceId) &&
				snapshot.surfaces[target.invokerSurfaceId] &&
				target.routeIdentity === routeIdentity &&
				target.chatId === (context?.chatId ?? null) &&
				target.effectiveProjectKey === (context?.effectiveProjectKey ?? null)
			) {
				return {
					activeId: target.invokerSurfaceId,
					returnStack: snapshot.mobileReturnStack.slice(0, index),
				};
			}
		}
		const recentSurfaceId = this.#mostRecentSurfaceIds.find(isAvailable);
		const workspaceWindows = collectWindowNodes(snapshot.desktopRoot);
		const sourceWindowRecentSurfaceId = collectWindowNodes(sourceSnapshot.desktopRoot)
			.filter((workspaceWindow) => workspaceWindow.tabs.order.some(isExcluded))
			.flatMap((workspaceWindow) => workspaceWindow.tabs.mru)
			.find(isAvailable);
		const activeWindowSurfaceId = workspaceWindows
			.map((workspaceWindow) => workspaceWindow.tabs.activeId)
			.find(isAvailable);
		const recentWindowSurfaceId = workspaceWindows
			.flatMap((workspaceWindow) => workspaceWindow.tabs.mru)
			.find(isAvailable);
		const currentMobileSurfaceId = isAvailable(snapshot.mobileActiveSurfaceId)
			? snapshot.mobileActiveSurfaceId
			: null;
		const activeId =
			recentSurfaceId ??
			sourceWindowRecentSurfaceId ??
			activeWindowSurfaceId ??
			recentWindowSurfaceId ??
			currentMobileSurfaceId;
		if (!activeId) throw new Error('No mobile return surface is available');
		return {
			activeId,
			returnStack: [],
		};
	}

	noteActivation(surfaceId: string): void {
		this.#mostRecentSurfaceIds = [
			surfaceId,
			...this.#mostRecentSurfaceIds.filter((id) => id !== surfaceId),
		];
	}

	planDesktopReturn(snapshot: WorkspaceLayoutSnapshot): readonly WorkspaceLayoutMutation[] {
		return planDesktopReturnMutations(snapshot, this.#mostRecentSurfaceIds);
	}
}
