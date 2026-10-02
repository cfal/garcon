import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import type { TerminalClientSession } from '$lib/terminal/sessions/terminal-registry-types.js';
import type { SingletonSurfaceRegistry } from './singleton-surfaces.svelte.js';
import type { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import type { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte.js';

type PlacedTerminalSession = Pick<TerminalClientSession, 'metadata' | 'attachmentState'>;
export type WorkspaceTerminals = Pick<TerminalRegistry,
	'create' | 'list' | 'displayName' | 'executorIdFor' | 'requestTermination' |
	'disposeTerminatedSession' | 'prepareRendererTransfer' | 'executorInventories'
> & {
	readonly sessions: Readonly<Record<string, PlacedTerminalSession>>;
	readonly orderedSessions: readonly PlacedTerminalSession[];
	readonly pendingCreates: Readonly<Record<string, Pick<TerminalRegistry['pendingCreates'][string],
		'requestedInitialWorkingDirectory' | 'executorId'
	>>>;
};

export type WorkspaceFiles = Pick<FileSessionRegistry, 'destroy' | 'prepareDestructiveViews'> & {
	get(sessionId: string): (Pick<FileViewSession, 'mutationGuarded'> & {
		readonly editor: Pick<NonNullable<FileViewSession['editor']>, 'prepareRendererTransfer'> | null;
	}) | null;
};

export type WorkspaceSingletons = Pick<SingletonSurfaceRegistry,
	'tickets' | 'ticketsIfPresent' | 'disposeSurface' | 'setPresentationVisible'
> & {
	commitIfPresent(): Pick<CommitController, 'canClose' | 'retainedDraftCount' | 'discardDrafts'> | null;
	chatCanvasIfPresent(): Pick<CanvasController, 'prepareClose'> | null;
};
