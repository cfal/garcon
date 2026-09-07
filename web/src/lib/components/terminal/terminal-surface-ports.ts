import type {
	TerminalInputControls,
	TerminalToolbarKey,
} from '$lib/terminal/runtime/terminal-input-controls.svelte.js';
import type { TerminalClientSession } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import type { WorkspaceLayoutSnapshot } from '$lib/workspace/surface-types.js';

export interface TerminalSurfaceRuntimePort {
	readonly inputControls: Pick<TerminalInputControls, 'ctrlMode' | 'altMode' | 'toggleModifier'>;
	sendToolbarKey(key: TerminalToolbarKey): void;
	attach(element: HTMLElement): { lease: number; ready: Promise<void> };
	park(lease: number): void;
	scheduleFit(): void;
	focus(): void;
	pasteFromClipboard(): Promise<unknown>;
	applyFontSize(fontSize: number): void;
}

export interface TerminalSurfaceRegistryPort {
	readonly sessions: Readonly<Record<string, TerminalClientSession>>;
	readonly orderedSessions: readonly TerminalClientSession[];
	readonly listStatus: 'idle' | 'loading' | 'ready' | 'failed';
	readonly listError: string | null;
	ensureRuntime(terminalId: string): Promise<TerminalSurfaceRuntimePort>;
	reattach(terminalId: string): void;
	rename(terminalId: string, title: string | null): Promise<void>;
	list(): Promise<void>;
}

export interface TerminalSurfaceWorkspacePort {
	readonly layout: { readonly snapshot: WorkspaceLayoutSnapshot };
	switchTerminalSurface(currentTerminalId: string, nextTerminalId: string): Promise<void>;
	createTerminalReplacing(currentTerminalId: string, requestKey?: string): Promise<string>;
	terminateTerminalSession(terminalId: string): Promise<boolean>;
	closeSurface(surfaceId: string): Promise<boolean>;
	isSurfaceCloseBlocked(surfaceId: string): boolean;
}
