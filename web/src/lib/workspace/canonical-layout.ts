import { DEFAULT_WORKSPACE_SIDEBAR_WIDTH } from './sidebar-sizing.js';
import {
	CHAT_SURFACE_ID,
	TERMINAL_LAUNCHER_ID,
	portableSingletonDescriptor,
	singletonSurfaceId,
	type PortableSingletonKind,
	type SurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';

export const CANONICAL_MAIN_SINGLETON_KINDS = ['git', 'pull-requests'] as const;
export const CANONICAL_SIDEBAR_SINGLETON_KINDS = ['files', 'commit'] as const;

export const CANONICAL_MAIN_SURFACE_IDS = [
	CHAT_SURFACE_ID,
	...CANONICAL_MAIN_SINGLETON_KINDS.map((kind) => singletonSurfaceId(kind)),
] as const;
export const CANONICAL_SIDEBAR_SURFACE_IDS = CANONICAL_SIDEBAR_SINGLETON_KINDS.map((kind) =>
	singletonSurfaceId(kind),
);

const CANONICAL_SURFACE_DESCRIPTORS: readonly SurfaceDescriptor[] = [
	{ id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' },
	...CANONICAL_MAIN_SINGLETON_KINDS.map((kind) => portableSingletonDescriptor(kind)),
	...CANONICAL_SIDEBAR_SINGLETON_KINDS.map((kind) => portableSingletonDescriptor(kind)),
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
		main: {
			order: [...CANONICAL_MAIN_SURFACE_IDS],
			activeId: CHAT_SURFACE_ID,
			mru: [...CANONICAL_MAIN_SURFACE_IDS],
		},
		sidebar: {
			order: [...CANONICAL_SIDEBAR_SURFACE_IDS],
			activeId: CANONICAL_SIDEBAR_SURFACE_IDS[0],
			mru: [...CANONICAL_SIDEBAR_SURFACE_IDS],
		},
		surfaces: { ...CANONICAL_SURFACES },
		sidebarOpen: false,
		desiredSidebarWidth: DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
		dialogFileSurfaceId: null,
		manualFullscreen: false,
		mobileActiveSurfaceId: CHAT_SURFACE_ID,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

export function nextSidebarSeedKind(
	snapshot: WorkspaceLayoutSnapshot,
): PortableSingletonKind | null {
	return (
		CANONICAL_SIDEBAR_SINGLETON_KINDS.find(
			(kind) => !snapshot.surfaces[singletonSurfaceId(kind)],
		) ?? null
	);
}

export function canOpenCanonicalSidebar(snapshot: WorkspaceLayoutSnapshot): boolean {
	return snapshot.sidebar.order.length > 0 || nextSidebarSeedKind(snapshot) !== null;
}

export function isCanonicalFirstRunLayout(snapshot: WorkspaceLayoutSnapshot): boolean {
	const pullRequestsSurfaceId = singletonSurfaceId('pull-requests');
	const expectedMain = snapshot.surfaces[pullRequestsSurfaceId]
		? CANONICAL_MAIN_SURFACE_IDS
		: CANONICAL_MAIN_SURFACE_IDS.filter((surfaceId) => surfaceId !== pullRequestsSurfaceId);
	return (
		hasExactOrder(snapshot.main.order, expectedMain) &&
		snapshot.main.activeId === CHAT_SURFACE_ID &&
		hasExactOrder(snapshot.sidebar.order, CANONICAL_SIDEBAR_SURFACE_IDS) &&
		snapshot.sidebar.activeId === CANONICAL_SIDEBAR_SURFACE_IDS[0] &&
		!snapshot.sidebarOpen &&
		!snapshot.dialogFileSurfaceId &&
		snapshot.mobileOnlySurfaceIds.length === 0 &&
		snapshot.unplacedTerminalIds.length === 0
	);
}

export function canOmitCanonicalPullRequests(snapshot: WorkspaceLayoutSnapshot): boolean {
	const pullRequestsSurfaceId = singletonSurfaceId('pull-requests');
	if (snapshot.main.activeId === pullRequestsSurfaceId) return false;
	const mainWithoutLauncher = snapshot.main.order.filter(
		(surfaceId) => surfaceId !== TERMINAL_LAUNCHER_ID,
	);
	return (
		hasExactOrder(mainWithoutLauncher, CANONICAL_MAIN_SURFACE_IDS) &&
		hasExactOrder(snapshot.sidebar.order, CANONICAL_SIDEBAR_SURFACE_IDS)
	);
}
