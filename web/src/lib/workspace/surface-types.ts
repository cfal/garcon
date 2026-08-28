export const CHAT_SURFACE_ID = 'singleton:chat' as const;
export const TERMINAL_LAUNCHER_ID = 'terminal-launcher' as const;
export const MAX_MOBILE_RETURN_TARGETS = 32;
export const MAX_WORKSPACE_PANES = 4;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;
export const PORTABLE_SINGLETON_KINDS = [
	'git',
	'git-history',
	'git-compare',
	'pull-requests',
	'files',
	'commit',
] as const;
export const TRANSIENT_MOBILE_SINGLETON_KINDS = ['git-history', 'git-compare'] as const;

// Pane and split IDs carry prefixes so they can never collide with the
// reserved presentation hosts 'mobile' and 'dialog'.
export type PaneId = `pane-${string}`;
export type SplitId = `split-${string}`;
export type SplitDirection = 'horizontal' | 'vertical';
export type SplitEdge = 'left' | 'right' | 'top' | 'bottom';

export type PresentationHostId = PaneId | 'mobile' | 'dialog';
export type DesktopPlacement =
	| { type: 'pane'; paneId: PaneId }
	| { type: 'new-pane'; anchorPaneId: PaneId }
	| { type: 'dialog' };

export type FocusOwner =
	| { kind: 'surface'; surfaceId: string }
	| { kind: 'chat-list' }
	| { kind: 'pane-chrome'; paneId: PaneId; surfaceId: string };

export type PortableSingletonKind = (typeof PORTABLE_SINGLETON_KINDS)[number];
export type TransientMobileSingletonKind = (typeof TRANSIENT_MOBILE_SINGLETON_KINDS)[number];
export type SingletonSurfaceKind = 'chat' | PortableSingletonKind;

export type PortableSingletonDescriptor = {
	[K in PortableSingletonKind]: {
		id: `singleton:${K}`;
		type: 'singleton';
		kind: K;
	};
}[PortableSingletonKind];

export type SurfaceDescriptor =
	| { id: typeof CHAT_SURFACE_ID; type: 'singleton'; kind: 'chat' }
	| PortableSingletonDescriptor
	| { id: string; type: 'terminal'; terminalId: string }
	| { id: string; type: 'file'; fileSessionId: string }
	| { id: typeof TERMINAL_LAUNCHER_ID; type: 'terminal-launcher' };

export type ActiveSurfaceKind = SingletonSurfaceKind | 'terminal' | 'file' | 'terminal-launcher';

// Tab state of a single pane: ordered tabs, the active tab, and a most
// recently used stack kept as a complete permutation of order.
export interface PaneTabState {
	readonly order: readonly string[];
	readonly activeId: string | null;
	readonly mru: readonly string[];
}

export interface PaneNode {
	readonly type: 'pane';
	readonly id: PaneId;
	readonly tabs: PaneTabState;
}

export interface WorkspaceSplitNode {
	readonly type: 'split';
	readonly id: SplitId;
	readonly direction: SplitDirection;
	readonly ratio: number;
	readonly children: readonly [DesktopLayoutNode, DesktopLayoutNode];
}

export type DesktopLayoutNode = PaneNode | WorkspaceSplitNode;

export interface MobileReturnTarget {
	invokerSurfaceId: string;
	invokerHost: PaneId | 'mobile';
	chatId: string | null;
	effectiveProjectKey: string | null;
	routeIdentity: string;
}

export interface WorkspaceLayoutSnapshot {
	readonly desktopRoot: DesktopLayoutNode;
	readonly surfaces: Readonly<Record<string, SurfaceDescriptor>>;
	readonly fullscreenPaneId: PaneId | null;
	readonly dialogFileSurfaceId: string | null;
	readonly mobileActiveSurfaceId: string;
	readonly mobileOnlySurfaceIds: readonly string[];
	readonly mobileReturnStack: readonly MobileReturnTarget[];
	readonly unplacedTerminalIds: readonly string[];
}

export interface WorkspaceLayoutReader {
	readonly revision: number;
	readonly snapshot: WorkspaceLayoutSnapshot;
	readonly chatPaneId: PaneId;
	readonly defaultActiveId: string;
	surface(surfaceId: string): SurfaceDescriptor | null;
}

export interface WorkspaceLayoutCommitPort {
	publish(expectedRevision: number, next: WorkspaceLayoutSnapshot): boolean;
}

export type WorkspaceLayoutMutation =
	| { type: 'register-surface'; surface: SurfaceDescriptor; paneId?: PaneId; index?: number }
	| {
			type: 'register-surface-in-split';
			surface: SurfaceDescriptor;
			targetPaneId: PaneId;
			edge: SplitEdge;
			newPaneId: PaneId;
			splitId: SplitId;
	  }
	| { type: 'replace-surface'; previousId: string; surface: SurfaceDescriptor }
	| { type: 'swap-terminal-placements'; firstSurfaceId: string; secondSurfaceId: string }
	| { type: 'activate-pane-tab'; paneId: PaneId; surfaceId: string }
	| { type: 'move-tab'; surfaceId: string; destinationPaneId: PaneId; index?: number }
	| { type: 'assign-to-pane'; surfaceId: string; destinationPaneId: PaneId; index?: number }
	| {
			type: 'split-tab-to-edge';
			surfaceId: string;
			targetPaneId: PaneId;
			edge: SplitEdge;
			newPaneId: PaneId;
			splitId: SplitId;
	  }
	| { type: 'merge-pane'; sourcePaneId: PaneId; destinationPaneId: PaneId }
	| { type: 'set-split-ratio'; splitId: SplitId; ratio: number }
	| { type: 'set-fullscreen-pane'; paneId: PaneId | null }
	| { type: 'place-in-dialog'; surfaceId: string }
	| { type: 'move-dialog-to-pane'; surfaceId: string; destinationPaneId: PaneId; index?: number }
	| { type: 'unplace-terminal'; terminalId: string }
	| { type: 'forget-terminal'; terminalId: string }
	| { type: 'remove-surface'; surfaceId: string }
	| {
			type: 'set-mobile-presentation';
			activeId: string;
			returnStack: readonly MobileReturnTarget[];
	  };

export function singletonSurfaceId<K extends SingletonSurfaceKind>(kind: K): `singleton:${K}` {
	return `singleton:${kind}`;
}

export function portableSingletonDescriptor(
	kind: PortableSingletonKind,
): PortableSingletonDescriptor {
	switch (kind) {
		case 'git':
			return { id: singletonSurfaceId(kind), type: 'singleton', kind };
		case 'git-history':
			return { id: singletonSurfaceId(kind), type: 'singleton', kind };
		case 'git-compare':
			return { id: singletonSurfaceId(kind), type: 'singleton', kind };
		case 'pull-requests':
			return { id: singletonSurfaceId(kind), type: 'singleton', kind };
		case 'files':
			return { id: singletonSurfaceId(kind), type: 'singleton', kind };
		case 'commit':
			return { id: singletonSurfaceId(kind), type: 'singleton', kind };
	}
}

export function isTransientMobileSingletonKind(
	kind: PortableSingletonKind,
): kind is TransientMobileSingletonKind {
	return TRANSIENT_MOBILE_SINGLETON_KINDS.includes(kind as TransientMobileSingletonKind);
}

export function terminalSurfaceId(terminalId: string): string {
	return `terminal:${terminalId}`;
}

export function fileSurfaceId(fileSessionId: string): string {
	return `file:${fileSessionId}`;
}

export function isPortableSingleton(
	surface: SurfaceDescriptor,
): surface is Extract<SurfaceDescriptor, { type: 'singleton' }> & { kind: PortableSingletonKind } {
	return surface.type === 'singleton' && surface.kind !== 'chat';
}

export function splitEdgeDirection(edge: SplitEdge): SplitDirection {
	return edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
}

export function splitEdgePosition(edge: SplitEdge): 'before' | 'after' {
	return edge === 'left' || edge === 'top' ? 'before' : 'after';
}
