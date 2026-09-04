import * as m from '$lib/paraglide/messages.js';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import { terminalDisplayName } from '$lib/terminal/sessions/terminal-display-name.js';
import { createRandomId } from '$lib/utils/random-id.js';
import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
import {
	MAX_WORKSPACE_WINDOWS,
	TERMINAL_LAUNCHER_ID,
	terminalSurfaceId,
	type WorkspaceWindowId,
	type WorkspacePartitionId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutReader,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';
import { collectWindowNodes, windowNodeById } from './window-tree.js';
import { reduceWorkspaceLayout } from './workspace-layout.svelte.js';
import type { WorkspaceCommit } from './workspace-commit.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';
import { isCanonicalFirstRunLayout } from './canonical-layout.js';

interface SurfaceReservations {
	has(surfaceId: string): boolean;
	add(surfaceId: string): unknown;
	delete(surfaceId: string): unknown;
}

interface TerminalCloseGuardRequest {
	surfaceId: string;
	title: string;
	description: string;
	confirmLabel: string;
}

interface MobileReturnPlan {
	activeId: string;
	returnStack: WorkspaceLayoutSnapshot['mobileReturnStack'];
}

interface TerminalPlacementServiceDeps {
	layout: WorkspaceLayoutReader;
	terminals: TerminalRegistry;
	reservations: SurfaceReservations;
	isWindowReserved(windowId: WorkspaceWindowId): boolean;
	commit: WorkspaceCommit;
	commitDestroyedRemoval(surfaceId: string, mutations: WorkspaceMutationPlan): Promise<boolean>;
	currentProjectPath(): string | null;
	isMobile(): boolean;
	cancelWorkspaceDrag(): void;
	windowOf(surfaceId: string): WorkspaceWindowId | null;
	defaultWindowId(): WorkspaceWindowId;
	defaultActiveId(): string;
	lastFocusedSurfaceId(): string;
	focusSurface(surfaceId: string): Promise<void>;
	present(surfaceId: string): void;
	resolveMobileReturn(
		excluding: string | ReadonlySet<string>,
		snapshot?: WorkspaceLayoutSnapshot,
	): MobileReturnPlan;
	confirmClose(request: TerminalCloseGuardRequest): Promise<boolean>;
	clearAttachmentError(surfaceId: string): void;
}

export class TerminalPlacementService {
	#terminalCreateRequestIds = new Map<string, string>();
	#terminalTerminateRequestIds = new Map<string, string>();
	#pendingTerminatedTerminalIds = new Set<string>();

	constructor(private readonly deps: TerminalPlacementServiceDeps) {}

	async create(windowId: WorkspaceWindowId, requestKey?: string): Promise<string> {
		this.deps.cancelWorkspaceDrag();
		const terminalId = requestKey
			? await this.#retryCreate(requestKey)
			: await this.#createWithRequestId(createRandomId());
		const surfaceId = terminalSurfaceId(terminalId);
		let current = false;
		try {
			current = await this.deps.commit(
				(latest) => {
					const destinationWindowId = this.#resolveWindowId(latest, windowId);
					if (latest.surfaces[surfaceId]) {
						const existingWindowId = this.#windowOf(latest, surfaceId);
						const mutations: WorkspaceLayoutMutation[] = [
							existingWindowId === destinationWindowId
								? { type: 'activate-window-tab', windowId: destinationWindowId, surfaceId }
								: { type: 'move-tab', surfaceId, destinationWindowId },
						];
						if (this.deps.isMobile()) {
							mutations.push({
								type: 'set-mobile-presentation',
								activeId: surfaceId,
								returnStack: latest.mobileReturnStack,
							});
						}
						return mutations;
					}
					const mutations: WorkspaceLayoutMutation[] = [];
					if (
						latest.surfaces[TERMINAL_LAUNCHER_ID]?.type === 'terminal-launcher' &&
						!this.deps.reservations.has(TERMINAL_LAUNCHER_ID)
					) {
						mutations.push({ type: 'remove-surface', surfaceId: TERMINAL_LAUNCHER_ID });
					}
					mutations.push(
						{
							type: 'register-surface',
							surface: { id: surfaceId, type: 'terminal', terminalId },
							windowId: destinationWindowId,
						},
						{ type: 'activate-window-tab', windowId: destinationWindowId, surfaceId },
					);
					if (this.deps.isMobile()) {
						mutations.push({
							type: 'set-mobile-presentation',
							activeId: surfaceId,
							returnStack: latest.mobileReturnStack,
						});
					}
					return mutations;
				},
				{ requiredPublication: true },
			);
			if (!this.deps.layout.surface(surfaceId)) {
				throw new Error(`Terminal surface was not placed: ${surfaceId}`);
			}
		} catch (error) {
			await this.#rollbackUnplaced(terminalId, error);
		}
		if (!current) return terminalId;
		this.deps.present(surfaceId);
		return terminalId;
	}

	// Creates a terminal in a new window adjacent to the anchor window.
	async createInNewWindow(anchorWindowId: WorkspaceWindowId, requestKey?: string): Promise<string> {
		if (this.deps.isMobile()) return this.create(this.deps.defaultWindowId(), requestKey);
		this.deps.cancelWorkspaceDrag();
		const terminalId = requestKey
			? await this.#retryCreate(requestKey)
			: await this.#createWithRequestId(createRandomId());
		const surfaceId = terminalSurfaceId(terminalId);
		const newWindowId = `window-${createRandomId()}` as WorkspaceWindowId;
		const partitionId = `partition-${createRandomId()}` as WorkspacePartitionId;
		let current = false;
		try {
			current = await this.deps.commit(
				(latest) => {
					const currentAnchorWindowId = this.#resolveWindowId(latest, anchorWindowId);
					const mutations: WorkspaceLayoutMutation[] = [];
					if (
						latest.surfaces[TERMINAL_LAUNCHER_ID]?.type === 'terminal-launcher' &&
						!this.deps.reservations.has(TERMINAL_LAUNCHER_ID)
					) {
						mutations.push({ type: 'remove-surface', surfaceId: TERMINAL_LAUNCHER_ID });
					}
					if (latest.surfaces[surfaceId]) {
						const existingWindowId = this.#windowOf(latest, surfaceId);
						mutations.push(
							existingWindowId === currentAnchorWindowId
								? { type: 'activate-window-tab', windowId: currentAnchorWindowId, surfaceId }
								: { type: 'move-tab', surfaceId, destinationWindowId: currentAnchorWindowId },
						);
						if (this.deps.isMobile()) {
							mutations.push({
								type: 'set-mobile-presentation',
								activeId: surfaceId,
								returnStack: latest.mobileReturnStack,
							});
						}
						return mutations;
					}
					if (this.deps.isMobile()) {
						mutations.push(
							{
								type: 'register-surface',
								surface: { id: surfaceId, type: 'terminal', terminalId },
								windowId: currentAnchorWindowId,
							},
							{ type: 'activate-window-tab', windowId: currentAnchorWindowId, surfaceId },
							{
								type: 'set-mobile-presentation',
								activeId: surfaceId,
								returnStack: latest.mobileReturnStack,
							},
						);
						return mutations;
					}
					if (collectWindowNodes(latest.desktopRoot).length >= MAX_WORKSPACE_WINDOWS) {
						throw new Error(m.workspace_window_limit_reached({ count: MAX_WORKSPACE_WINDOWS }));
					}
					mutations.push({
						type: 'register-surface-in-new-window',
						surface: { id: surfaceId, type: 'terminal', terminalId },
						targetWindowId: currentAnchorWindowId,
						edge: 'right',
						newWindowId,
						partitionId,
					});
					return mutations;
				},
				{ requiredPublication: true },
			);
			if (!this.deps.layout.surface(surfaceId)) {
				throw new Error(`Terminal surface was not placed: ${surfaceId}`);
			}
		} catch (error) {
			await this.#rollbackUnplaced(terminalId, error);
		}
		if (!current) return terminalId;
		this.deps.present(surfaceId);
		return terminalId;
	}

	async createReplacing(currentTerminalId: string, requestKey?: string): Promise<string> {
		const currentSurfaceId = terminalSurfaceId(currentTerminalId);
		const currentSurface = this.deps.layout.surface(currentSurfaceId);
		if (currentSurface?.type !== 'terminal' || this.deps.reservations.has(currentSurfaceId)) {
			throw new Error('The current terminal tab is no longer available');
		}
		this.deps.reservations.add(currentSurfaceId);
		try {
			const terminalId = requestKey
				? await this.#retryCreate(requestKey)
				: await this.#createWithRequestId(createRandomId());
			const surfaceId = terminalSurfaceId(terminalId);
			let current = false;
			try {
				current = await this.deps.commit(
					(latest) => {
						const latestSurface = latest.surfaces[currentSurfaceId];
						if (latestSurface?.type !== 'terminal') {
							throw new Error('The current terminal tab changed before it could be replaced');
						}
						return [
							{
								type: 'replace-surface',
								previousId: currentSurfaceId,
								surface: { id: surfaceId, type: 'terminal', terminalId },
							},
						];
					},
					{ requiredPublication: true },
				);
			} catch (error) {
				await this.#rollbackUnplaced(terminalId, error);
			}
			if (!current) return terminalId;
			this.deps.present(surfaceId);
			return terminalId;
		} finally {
			this.deps.reservations.delete(currentSurfaceId);
		}
	}

	async open(terminalId: string, preferredWindowId: WorkspaceWindowId): Promise<void> {
		if (!this.deps.terminals.sessions[terminalId]) return;
		const surfaceId = terminalSurfaceId(terminalId);
		if (this.deps.layout.surface(surfaceId)) {
			await this.deps.focusSurface(surfaceId);
			return;
		}
		const current = await this.deps.commit((latest) => {
			const destinationWindowId = this.#resolveWindowId(latest, preferredWindowId);
			const mutations: WorkspaceLayoutMutation[] = [
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'terminal', terminalId },
					windowId: destinationWindowId,
				},
				{ type: 'activate-window-tab', windowId: destinationWindowId, surfaceId },
			];
			if (this.deps.isMobile()) {
				mutations.push({
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack: latest.mobileReturnStack,
				});
			}
			return mutations;
		});
		if (current) this.deps.present(surfaceId);
	}

	async switch(currentTerminalId: string, nextTerminalId: string): Promise<void> {
		if (currentTerminalId === nextTerminalId || !this.deps.terminals.sessions[nextTerminalId]) {
			return;
		}
		const currentSurfaceId = terminalSurfaceId(currentTerminalId);
		const nextSurfaceId = terminalSurfaceId(nextTerminalId);
		const current = await this.deps.commit((latest) => {
			const currentSurface = latest.surfaces[currentSurfaceId];
			if (currentSurface?.type !== 'terminal') return [];
			const nextSurface = latest.surfaces[nextSurfaceId];
			if (nextSurface) {
				if (nextSurface.type !== 'terminal') return [];
				if (this.deps.isMobile()) {
					return [
						{
							type: 'set-mobile-presentation',
							activeId: nextSurfaceId,
							returnStack: latest.mobileReturnStack,
						},
					];
				}
				return [
					{
						type: 'swap-terminal-placements',
						firstSurfaceId: currentSurfaceId,
						secondSurfaceId: nextSurfaceId,
					},
				];
			}
			return [
				{
					type: 'replace-surface',
					previousId: currentSurfaceId,
					surface: { id: nextSurfaceId, type: 'terminal', terminalId: nextTerminalId },
				},
			];
		});
		if (current) this.deps.present(nextSurfaceId);
	}

	async terminate(terminalId: string): Promise<boolean> {
		const session = this.deps.terminals.sessions[terminalId];
		if (!session) return false;
		const surfaceId = terminalSurfaceId(terminalId);
		if (this.deps.reservations.has(surfaceId)) return false;
		this.deps.reservations.add(surfaceId);
		let terminationAccepted = false;
		try {
			if (
				(session.metadata.processStatus === 'running' || session.attachmentState === 'attached') &&
				!(await this.deps.confirmClose({
					surfaceId,
					title: m.terminal_terminate_title({ name: terminalDisplayName(session.metadata) }),
					description: m.terminal_terminate_description(),
					confirmLabel: m.terminal_terminate(),
				}))
			) {
				return false;
			}
			await this.#requestAndDisposeTermination(terminalId);
			terminationAccepted = true;
			return true;
		} finally {
			this.deps.reservations.delete(surfaceId);
			const terminatedRemotely = this.#pendingTerminatedTerminalIds.delete(terminalId);
			if (terminationAccepted || terminatedRemotely) {
				await this.handleTerminated(terminalId);
			}
		}
	}

	async handleTerminated(terminalId: string): Promise<void> {
		const surfaceId = terminalSurfaceId(terminalId);
		this.#terminalTerminateRequestIds.delete(terminalId);
		if (this.deps.reservations.has(surfaceId)) {
			this.#pendingTerminatedTerminalIds.add(terminalId);
			return;
		}
		this.#pendingTerminatedTerminalIds.delete(terminalId);
		const surface = this.deps.layout.surface(surfaceId);
		if (surface?.type !== 'terminal' || surface.terminalId !== terminalId) {
			await this.deps.commit([{ type: 'forget-terminal', terminalId }]);
			return;
		}
		this.deps.reservations.add(surfaceId);
		try {
			const sourceWindowId = this.deps.windowOf(surfaceId);
			let mobileFallbackId: string | null = null;
			const current = await this.deps.commitDestroyedRemoval(surfaceId, (latest) => {
				if (!latest.surfaces[surfaceId]) return [];
				const mutations: WorkspaceLayoutMutation[] = [{ type: 'forget-terminal', terminalId }];
				if (this.deps.isMobile() && latest.mobileActiveSurfaceId === surfaceId) {
					// Resolve against the post-removal snapshot so window active/MRU
					// fallbacks no longer name the removed surface.
					const fallback = this.deps.resolveMobileReturn(
						surfaceId,
						reduceWorkspaceLayout(latest, mutations),
					);
					mobileFallbackId = fallback.activeId;
					mutations.push({
						type: 'set-mobile-presentation',
						activeId: fallback.activeId,
						returnStack: fallback.returnStack,
					});
				}
				return mutations;
			});
			this.deps.clearAttachmentError(surfaceId);
			if (!current) return;
			const sourceWindowActive = sourceWindowId
				? windowNodeById(this.deps.layout.snapshot.desktopRoot, sourceWindowId)?.tabs.activeId
				: null;
			const fallbackSurfaceId =
				mobileFallbackId ?? sourceWindowActive ?? this.deps.defaultActiveId();
			this.deps.present(fallbackSurfaceId);
		} finally {
			this.deps.reservations.delete(surfaceId);
		}
	}

	async afterPlacementReleased(terminalId: string): Promise<void> {
		if (this.#pendingTerminatedTerminalIds.delete(terminalId)) {
			await this.handleTerminated(terminalId);
			return;
		}
		const surfaceId = terminalSurfaceId(terminalId);
		if (this.deps.layout.surface(surfaceId) || this.deps.reservations.has(surfaceId)) return;
		const session = this.deps.terminals.sessions[terminalId];
		if (session?.metadata.processStatus !== 'exited') return;
		this.deps.reservations.add(surfaceId);
		let terminationAccepted = false;
		try {
			await this.#requestAndDisposeTermination(terminalId);
			terminationAccepted = true;
		} finally {
			this.deps.reservations.delete(surfaceId);
			const terminatedRemotely = this.#pendingTerminatedTerminalIds.delete(terminalId);
			if (terminationAccepted || terminatedRemotely) {
				await this.handleTerminated(terminalId);
			}
		}
	}

	async focusMostRecentOrCreate(preferredWindowId: WorkspaceWindowId): Promise<void> {
		const focused = this.deps.layout.surface(this.deps.lastFocusedSurfaceId());
		if (focused?.type === 'terminal' && this.deps.terminals.sessions[focused.terminalId]) {
			await this.open(focused.terminalId, preferredWindowId);
			return;
		}
		let terminal = this.deps.terminals.orderedSessions.at(-1);
		if (!terminal && this.deps.terminals.listStatus !== 'ready') {
			await this.deps.terminals.list();
			terminal = this.deps.terminals.orderedSessions.at(-1);
		}
		if (terminal) {
			await this.open(terminal.metadata.terminalId, preferredWindowId);
			return;
		}
		if (
			this.deps.terminals.listStatus === 'ready' &&
			this.deps.terminals.orderedSessions.length < TERMINAL_SESSION_LIMIT
		) {
			await this.create(preferredWindowId, `terminal-empty-state:${preferredWindowId}`);
		}
	}

	async reconcile(
		liveTerminalIds: readonly string[],
		options: { deriveLauncher: boolean },
	): Promise<void> {
		const live = new Set(liveTerminalIds);
		let mobileFallbackId: string | null = null;
		for (const terminalId of this.#terminalTerminateRequestIds.keys()) {
			if (!live.has(terminalId)) this.#terminalTerminateRequestIds.delete(terminalId);
		}
		const current = await this.deps.commit((latest) => {
			const mutations: WorkspaceLayoutMutation[] = [];
			const removedSurfaceIds = new Set<string>();
			const survivingTerminalIds = new Set<string>();
			const explicitlyUnplacedTerminalIds = new Set(
				latest.unplacedTerminalIds.filter((terminalId) => live.has(terminalId)),
			);
			for (const terminalId of latest.unplacedTerminalIds) {
				if (!live.has(terminalId)) mutations.push({ type: 'forget-terminal', terminalId });
			}
			for (const surface of Object.values(latest.surfaces)) {
				if (surface.type !== 'terminal') continue;
				if (live.has(surface.terminalId)) {
					survivingTerminalIds.add(surface.terminalId);
					continue;
				}
				mutations.push({ type: 'remove-surface', surfaceId: surface.id });
				removedSurfaceIds.add(surface.id);
			}
			const launcher = latest.surfaces[TERMINAL_LAUNCHER_ID];
			const launcherReserved = Boolean(launcher && this.deps.reservations.has(launcher.id));
			if (live.size > 0 && launcher && !launcherReserved) {
				mutations.push({ type: 'remove-surface', surfaceId: launcher.id });
				removedSurfaceIds.add(launcher.id);
			} else if (
				live.size === 0 &&
				options.deriveLauncher &&
				!launcher &&
				isCanonicalFirstRunLayout(latest)
			) {
				mutations.push({
					type: 'register-surface',
					surface: { id: TERMINAL_LAUNCHER_ID, type: 'terminal-launcher' },
					windowId: this.deps.defaultWindowId(),
				});
			}
			const unrepresentedTerminalIds = [...live].filter(
				(terminalId) =>
					!survivingTerminalIds.has(terminalId) && !explicitlyUnplacedTerminalIds.has(terminalId),
			);
			if (live.size > 0 && survivingTerminalIds.size === 0 && !launcherReserved) {
				for (const terminalId of unrepresentedTerminalIds) {
					mutations.push({
						type: 'register-surface',
						surface: {
							id: terminalSurfaceId(terminalId),
							type: 'terminal',
							terminalId,
						},
						windowId: this.deps.defaultWindowId(),
					});
				}
			} else {
				for (const terminalId of unrepresentedTerminalIds) {
					mutations.push({ type: 'unplace-terminal', terminalId });
				}
			}
			if (this.deps.isMobile() && removedSurfaceIds.has(latest.mobileActiveSurfaceId)) {
				// Resolve against the post-removal snapshot so window active/MRU
				// fallbacks no longer name a removed surface.
				const fallback = this.deps.resolveMobileReturn(
					removedSurfaceIds,
					reduceWorkspaceLayout(latest, mutations),
				);
				mobileFallbackId = fallback.activeId;
				mutations.push({
					type: 'set-mobile-presentation',
					activeId: fallback.activeId,
					returnStack: fallback.returnStack,
				});
			}
			return mutations;
		});
		if (current && mobileFallbackId) this.deps.present(mobileFallbackId);
	}

	async activateLauncher(windowId: WorkspaceWindowId): Promise<void> {
		const launcherId = TERMINAL_LAUNCHER_ID;
		if (!this.deps.layout.surface(launcherId) || this.deps.reservations.has(launcherId)) {
			return;
		}
		this.deps.reservations.add(launcherId);
		try {
			const terminalId = await this.#retryCreate(`launcher:${windowId}`);
			const surfaceId = terminalSurfaceId(terminalId);
			let current = false;
			try {
				current = await this.deps.commit(
					[
						{
							type: 'replace-surface',
							previousId: launcherId,
							surface: { id: surfaceId, type: 'terminal', terminalId },
						},
						{ type: 'activate-window-tab', windowId, surfaceId },
					],
					{ requiredPublication: true },
				);
			} catch (error) {
				await this.#rollbackUnplaced(terminalId, error);
			}
			if (current) this.deps.present(surfaceId);
		} finally {
			this.deps.reservations.delete(launcherId);
		}
	}

	#windowOf(snapshot: WorkspaceLayoutSnapshot, surfaceId: string): WorkspaceWindowId | null {
		for (const workspaceWindow of collectWindowNodes(snapshot.desktopRoot)) {
			if (workspaceWindow.tabs.order.includes(surfaceId)) return workspaceWindow.id;
		}
		return null;
	}

	#resolveWindowId(
		snapshot: WorkspaceLayoutSnapshot,
		preferredWindowId: WorkspaceWindowId,
	): WorkspaceWindowId {
		if (
			windowNodeById(snapshot.desktopRoot, preferredWindowId) &&
			!this.deps.isWindowReserved(preferredWindowId)
		) {
			return preferredWindowId;
		}
		const defaultWindowId = this.deps.defaultWindowId();
		if (
			windowNodeById(snapshot.desktopRoot, defaultWindowId) &&
			!this.deps.isWindowReserved(defaultWindowId)
		) {
			return defaultWindowId;
		}
		const firstWindow = collectWindowNodes(snapshot.desktopRoot).find(
			(workspaceWindow) => !this.deps.isWindowReserved(workspaceWindow.id),
		);
		if (!firstWindow) throw new Error('Workspace has no destination window');
		return firstWindow.id;
	}

	async #retryCreate(requestKey: string): Promise<string> {
		let requestId = this.#terminalCreateRequestIds.get(requestKey);
		if (requestId && !this.deps.terminals.pendingCreates[requestId]) {
			this.#terminalCreateRequestIds.delete(requestKey);
			requestId = undefined;
		}
		requestId ??= createRandomId();
		this.#terminalCreateRequestIds.set(requestKey, requestId);
		try {
			return await this.#createWithRequestId(requestId);
		} finally {
			if (!this.deps.terminals.pendingCreates[requestId]) {
				this.#terminalCreateRequestIds.delete(requestKey);
			}
		}
	}

	#createWithRequestId(requestId: string): Promise<string> {
		return this.deps.terminals.create(this.deps.currentProjectPath(), requestId);
	}

	async #requestTermination(terminalId: string): Promise<void> {
		let requestId = this.#terminalTerminateRequestIds.get(terminalId);
		if (!requestId) {
			requestId = createRandomId();
			this.#terminalTerminateRequestIds.set(terminalId, requestId);
		}
		await this.deps.terminals.requestTermination(terminalId, requestId);
	}

	async #requestAndDisposeTermination(terminalId: string): Promise<void> {
		if (!this.#pendingTerminatedTerminalIds.has(terminalId)) {
			await this.#requestTermination(terminalId);
		}
		this.#terminalTerminateRequestIds.delete(terminalId);
		this.deps.terminals.disposeTerminatedSession(terminalId);
	}

	async #rollbackUnplaced(terminalId: string, placementError: unknown): Promise<never> {
		if (this.deps.layout.surface(terminalSurfaceId(terminalId))) throw placementError;
		try {
			await this.#requestTermination(terminalId);
			this.deps.terminals.disposeTerminatedSession(terminalId);
			this.#terminalTerminateRequestIds.delete(terminalId);
		} catch (cleanupError) {
			throw new AggregateError(
				[placementError, cleanupError],
				`Failed to place or terminate terminal ${terminalId}`,
				{ cause: cleanupError },
			);
		}
		throw placementError;
	}
}
