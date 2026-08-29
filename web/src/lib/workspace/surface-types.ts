export const TERMINAL_LAUNCHER_ID = 'terminal-launcher' as const;
export const MAX_MOBILE_RETURN_TARGETS = 32;
export const MAX_WORKSPACE_WINDOWS = 4;
export const MIN_PARTITION_RATIO = 0.15;
export const MAX_PARTITION_RATIO = 0.85;
export const PORTABLE_SINGLETON_KINDS = [
	'git',
	'git-history',
	'git-compare',
	'pull-requests',
	'files',
	'commit',
] as const;
export const TRANSIENT_MOBILE_SINGLETON_KINDS = ['git-history', 'git-compare'] as const;

// Prefixes keep durable layout identities disjoint from reserved mobile and dialog hosts.
export type WorkspaceWindowId = `window-${string}`;
export type WorkspacePartitionId = `partition-${string}`;
export type WorkspacePartitionDirection = 'horizontal' | 'vertical';
export type WorkspaceWindowEdge = 'left' | 'right' | 'top' | 'bottom';
export type ChatViewSurfaceId = `chat-view:${WorkspaceWindowId}`;

export type PresentationHostId = WorkspaceWindowId | 'mobile' | 'dialog';
export type DesktopPlacement =
	| { type: 'window'; windowId: WorkspaceWindowId }
	| { type: 'new-window'; anchorWindowId: WorkspaceWindowId }
	| { type: 'dialog' };

export type FocusOwner =
	| { kind: 'surface'; surfaceId: string }
	| { kind: 'chat-list' }
	| { kind: 'window-chrome'; windowId: WorkspaceWindowId; surfaceId: string };

export type PortableSingletonKind = (typeof PORTABLE_SINGLETON_KINDS)[number];
export type TransientMobileSingletonKind = (typeof TRANSIENT_MOBILE_SINGLETON_KINDS)[number];

export type PortableSingletonDescriptor = {
	[K in PortableSingletonKind]: {
		id: `singleton:${K}`;
		type: 'singleton';
		kind: K;
	};
}[PortableSingletonKind];

export interface ChatViewSurfaceDescriptor {
	readonly id: ChatViewSurfaceId;
	readonly type: 'chat';
	readonly chatId: string | null;
}

export type SurfaceDescriptor =
	| ChatViewSurfaceDescriptor
	| PortableSingletonDescriptor
	| { id: string; type: 'terminal'; terminalId: string }
	| { id: string; type: 'file'; fileSessionId: string }
	| { id: typeof TERMINAL_LAUNCHER_ID; type: 'terminal-launcher' };

export type ActiveSurfaceKind =
	PortableSingletonKind | 'chat' | 'terminal' | 'file' | 'terminal-launcher';

export interface WorkspaceWindowTabState {
	readonly order: readonly string[];
	readonly activeId: string;
	readonly mru: readonly string[];
}

export interface WorkspaceWindowNode {
	readonly type: 'window';
	readonly id: WorkspaceWindowId;
	readonly tabs: WorkspaceWindowTabState;
}

export interface WorkspacePartitionNode {
	readonly type: 'partition';
	readonly id: WorkspacePartitionId;
	readonly direction: WorkspacePartitionDirection;
	readonly ratio: number;
	readonly children: readonly [DesktopWorkspaceNode, DesktopWorkspaceNode];
}

export type DesktopWorkspaceNode = WorkspaceWindowNode | WorkspacePartitionNode;

export interface MobileReturnTarget {
	invokerSurfaceId: string;
	invokerHost: WorkspaceWindowId | 'mobile';
	chatId: string | null;
	effectiveProjectKey: string | null;
	routeIdentity: string;
}

export interface WorkspaceLayoutSnapshot {
	readonly desktopRoot: DesktopWorkspaceNode;
	readonly surfaces: Readonly<Record<string, SurfaceDescriptor>>;
	readonly fullscreenWindowId: WorkspaceWindowId | null;
	readonly dialogFileSurfaceId: string | null;
	readonly mobileActiveSurfaceId: string;
	readonly mobileOnlySurfaceIds: readonly string[];
	readonly mobileReturnStack: readonly MobileReturnTarget[];
	readonly unplacedTerminalIds: readonly string[];
}

export function workspaceChatViewCount(
	snapshot: Pick<WorkspaceLayoutSnapshot, 'surfaces'>,
): number {
	return Object.values(snapshot.surfaces).filter((surface) => surface.type === 'chat').length;
}

export interface WorkspaceLayoutReader {
	readonly revision: number;
	readonly snapshot: WorkspaceLayoutSnapshot;
	readonly defaultWindowId: WorkspaceWindowId;
	readonly defaultActiveId: string;
	surface(surfaceId: string): SurfaceDescriptor | null;
}

export interface WorkspaceLayoutCommitPort {
	publish(expectedRevision: number, next: WorkspaceLayoutSnapshot): boolean;
}

export type WorkspaceLayoutMutation =
	| {
			type: 'register-surface';
			surface: SurfaceDescriptor;
			windowId?: WorkspaceWindowId;
			index?: number;
	  }
	| {
			type: 'register-surface-in-new-window';
			surface: SurfaceDescriptor;
			targetWindowId: WorkspaceWindowId;
			edge: WorkspaceWindowEdge;
			newWindowId: WorkspaceWindowId;
			partitionId: WorkspacePartitionId;
	  }
	| {
			type: 'open-chat-in-new-window';
			chatId: string;
			targetWindowId: WorkspaceWindowId;
			edge: WorkspaceWindowEdge;
			newWindowId: WorkspaceWindowId;
			partitionId: WorkspacePartitionId;
	  }
	| { type: 'set-window-chat'; windowId: WorkspaceWindowId; chatId: string | null }
	| { type: 'replace-surface'; previousId: string; surface: SurfaceDescriptor }
	| { type: 'swap-terminal-placements'; firstSurfaceId: string; secondSurfaceId: string }
	| { type: 'activate-window-tab'; windowId: WorkspaceWindowId; surfaceId: string }
	| {
			type: 'move-tab';
			surfaceId: string;
			destinationWindowId: WorkspaceWindowId;
			index?: number;
	  }
	| {
			type: 'move-chat-to-window';
			sourceWindowId: WorkspaceWindowId;
			destinationWindowId: WorkspaceWindowId;
	  }
	| {
			type: 'assign-to-window';
			surfaceId: string;
			destinationWindowId: WorkspaceWindowId;
			index?: number;
	  }
	| {
			type: 'move-tab-to-new-window';
			surfaceId: string;
			targetWindowId: WorkspaceWindowId;
			edge: WorkspaceWindowEdge;
			newWindowId: WorkspaceWindowId;
			partitionId: WorkspacePartitionId;
	  }
	| { type: 'close-window'; windowId: WorkspaceWindowId }
	| { type: 'set-partition-ratio'; partitionId: WorkspacePartitionId; ratio: number }
	| { type: 'set-fullscreen-window'; windowId: WorkspaceWindowId | null }
	| { type: 'place-in-dialog'; surfaceId: string }
	| {
			type: 'move-dialog-to-window';
			surfaceId: string;
			destinationWindowId: WorkspaceWindowId;
			index?: number;
	  }
	| { type: 'unplace-terminal'; terminalId: string }
	| { type: 'forget-terminal'; terminalId: string }
	| { type: 'remove-surface'; surfaceId: string }
	| {
			type: 'set-mobile-presentation';
			activeId: string;
			returnStack: readonly MobileReturnTarget[];
	  };

export function chatViewSurfaceId(windowId: WorkspaceWindowId): ChatViewSurfaceId {
	return `chat-view:${windowId}`;
}

export function singletonSurfaceId<K extends PortableSingletonKind>(kind: K): `singleton:${K}` {
	return `singleton:${kind}`;
}

export function portableSingletonDescriptor(
	kind: PortableSingletonKind,
): PortableSingletonDescriptor {
	return { id: singletonSurfaceId(kind), type: 'singleton', kind } as PortableSingletonDescriptor;
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
): surface is PortableSingletonDescriptor {
	return surface.type === 'singleton';
}

export function partitionDirectionForEdge(edge: WorkspaceWindowEdge): WorkspacePartitionDirection {
	return edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
}

export function windowEdgePosition(edge: WorkspaceWindowEdge): 'before' | 'after' {
	return edge === 'left' || edge === 'top' ? 'before' : 'after';
}
