import {
	CHAT_SURFACE_ID,
	TERMINAL_LAUNCHER_ID,
	portableSingletonDescriptor,
	singletonSurfaceId,
	type PaneId,
	type SurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';

export const CANONICAL_PANE_ID: PaneId = 'pane-main';
export const CANONICAL_SINGLETON_KINDS = ['git', 'pull-requests'] as const;

export const CANONICAL_SURFACE_IDS = [
	CHAT_SURFACE_ID,
	...CANONICAL_SINGLETON_KINDS.map((kind) => singletonSurfaceId(kind)),
] as const;

const CANONICAL_SURFACE_DESCRIPTORS: readonly SurfaceDescriptor[] = [
	{ id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' },
	...CANONICAL_SINGLETON_KINDS.map((kind) => portableSingletonDescriptor(kind)),
];
const CANONICAL_SURFACES: Readonly<Record<string, SurfaceDescriptor>> = Object.fromEntries(
	CANONICAL_SURFACE_DESCRIPTORS.map((surface) => [surface.id, surface]),
);

function hasExactOrder(actual: readonly string[], expected: readonly string[]): boolean {
	return (
		actual.length === expected.length &&
		actual.every((surfaceId, index) => surfaceId === expected[index])
	);
}

export function canonicalWorkspaceSnapshot(): WorkspaceLayoutSnapshot {
	return {
		desktopRoot: {
			type: 'pane',
			id: CANONICAL_PANE_ID,
			tabs: {
				order: [...CANONICAL_SURFACE_IDS],
				activeId: CHAT_SURFACE_ID,
				mru: [...CANONICAL_SURFACE_IDS],
			},
		},
		surfaces: { ...CANONICAL_SURFACES },
		fullscreenPaneId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: CHAT_SURFACE_ID,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

export function isCanonicalFirstRunLayout(snapshot: WorkspaceLayoutSnapshot): boolean {
	if (snapshot.desktopRoot.type !== 'pane' || snapshot.desktopRoot.id !== CANONICAL_PANE_ID) {
		return false;
	}
	const pullRequestsSurfaceId = singletonSurfaceId('pull-requests');
	const expectedOrder = snapshot.surfaces[pullRequestsSurfaceId]
		? CANONICAL_SURFACE_IDS
		: CANONICAL_SURFACE_IDS.filter((surfaceId) => surfaceId !== pullRequestsSurfaceId);
	return (
		hasExactOrder(snapshot.desktopRoot.tabs.order, expectedOrder) &&
		snapshot.desktopRoot.tabs.activeId === CHAT_SURFACE_ID &&
		!snapshot.fullscreenPaneId &&
		!snapshot.dialogFileSurfaceId &&
		snapshot.mobileOnlySurfaceIds.length === 0 &&
		snapshot.unplacedTerminalIds.length === 0
	);
}

export function canOmitCanonicalPullRequests(snapshot: WorkspaceLayoutSnapshot): boolean {
	if (snapshot.desktopRoot.type !== 'pane') return false;
	const pullRequestsSurfaceId = singletonSurfaceId('pull-requests');
	if (snapshot.desktopRoot.tabs.activeId === pullRequestsSurfaceId) return false;
	const orderWithoutLauncher = snapshot.desktopRoot.tabs.order.filter(
		(surfaceId) => surfaceId !== TERMINAL_LAUNCHER_ID,
	);
	return hasExactOrder(orderWithoutLauncher, CANONICAL_SURFACE_IDS);
}
