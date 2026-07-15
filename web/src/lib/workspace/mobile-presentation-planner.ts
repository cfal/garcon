import { planDesktopReturnMutations } from './responsive-handoff.js';
import {
	CHAT_SURFACE_ID,
	type MobileReturnTarget,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';

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
	#mostRecentSurfaceIds: string[] = [CHAT_SURFACE_ID];

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
	): MobileReturnPlan {
		const context = this.deps.getContext();
		const routeIdentity = this.deps.getRouteIdentity();
		const isExcluded = (surfaceId: string): boolean =>
			typeof excluding === 'string' ? surfaceId === excluding : excluding.has(surfaceId);
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
		const recent = this.#mostRecentSurfaceIds.find(
			(surfaceId) => !isExcluded(surfaceId) && Boolean(snapshot.surfaces[surfaceId]),
		);
		const activeMain = snapshot.main.activeId;
		return {
			activeId: recent ?? (activeMain && !isExcluded(activeMain) ? activeMain : CHAT_SURFACE_ID),
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
