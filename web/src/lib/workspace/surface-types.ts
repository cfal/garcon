export const CHAT_SURFACE_ID = 'singleton:chat' as const;
export const TERMINAL_LAUNCHER_ID = 'terminal-launcher' as const;
export const DEFAULT_RIGHT_SIDEBAR_WIDTH = 480;
export const MIN_RIGHT_SIDEBAR_WIDTH = 360;
export const MAX_PERSISTED_RIGHT_SIDEBAR_WIDTH = 1200;
export const MAX_MOBILE_RETURN_TARGETS = 32;

export type HostId = 'main' | 'sidebar';
export type PresentationHostId = HostId | 'mobile' | 'dialog';
export type DesktopPlacement = HostId | 'dialog';

export type FocusOwner =
	| { kind: 'surface'; surfaceId: string }
	| { kind: 'chat-list' }
	| { kind: 'host-chrome'; host: HostId; surfaceId: string };

export type SingletonSurfaceKind = 'chat' | 'git' | 'pull-requests' | 'files' | 'commit';
export type PortableSingletonKind = Exclude<SingletonSurfaceKind, 'chat'>;

type PortableSingletonDescriptor = {
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

export interface HostState {
	readonly order: readonly string[];
	readonly activeId: string | null;
	readonly mru: readonly string[];
}

export interface MobileReturnTarget {
	invokerSurfaceId: string;
	invokerHost: HostId | 'mobile';
	chatId: string | null;
	effectiveProjectKey: string | null;
	routeIdentity: string;
}

export interface WorkspaceLayoutSnapshot {
	readonly main: HostState;
	readonly sidebar: HostState;
	readonly surfaces: Readonly<Record<string, SurfaceDescriptor>>;
	readonly sidebarOpen: boolean;
	readonly desiredSidebarWidth: number;
	readonly dialogFileSurfaceId: string | null;
	readonly manualFullscreen: boolean;
	readonly mobileActiveSurfaceId: string;
	readonly mobileOnlySurfaceIds: readonly string[];
	readonly mobileReturnStack: readonly MobileReturnTarget[];
	readonly unplacedTerminalIds: readonly string[];
}

export interface WorkspaceLayoutReader {
	readonly revision: number;
	readonly snapshot: WorkspaceLayoutSnapshot;
	readonly activeMainId: string;
	readonly activeMainKind: ActiveSurfaceKind | null;
	surface(surfaceId: string): SurfaceDescriptor | null;
}

export interface WorkspaceLayoutCommitPort {
	publish(expectedRevision: number, next: WorkspaceLayoutSnapshot): boolean;
}

export type WorkspaceLayoutMutation =
	| { type: 'register-surface'; surface: SurfaceDescriptor; host?: HostId; index?: number }
	| { type: 'replace-surface'; previousId: string; surface: SurfaceDescriptor }
	| { type: 'swap-terminal-placements'; firstSurfaceId: string; secondSurfaceId: string }
	| { type: 'focus-host'; host: HostId; surfaceId: string }
	| { type: 'move-to-host'; surfaceId: string; destination: HostId; index?: number }
	| { type: 'assign-to-host'; surfaceId: string; destination: HostId; index?: number }
	| { type: 'place-in-dialog'; surfaceId: string }
	| { type: 'move-dialog-to-host'; surfaceId: string; destination: HostId; index?: number }
	| { type: 'unplace-terminal'; terminalId: string }
	| { type: 'forget-terminal'; terminalId: string }
	| { type: 'remove-surface'; surfaceId: string }
	| { type: 'set-sidebar-open'; open: boolean }
	| { type: 'set-sidebar-width'; width: number }
	| { type: 'set-manual-fullscreen'; enabled: boolean }
	| {
			type: 'set-mobile-presentation';
			activeId: string;
			returnStack: readonly MobileReturnTarget[];
	  };

export function singletonSurfaceId<K extends SingletonSurfaceKind>(kind: K): `singleton:${K}` {
	return `singleton:${kind}`;
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
