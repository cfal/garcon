import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import {
	CHAT_SURFACE_ID,
	MAX_WORKSPACE_PANES,
	portableSingletonDescriptor,
	singletonSurfaceId,
	type ActiveSurfaceKind,
	type DesktopPlacement,
	type PaneId,
	type FocusOwner,
	type PortableSingletonKind,
	type SplitEdge,
	type SplitId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
	type PresentationHostId,
} from './surface-types.js';
import { collectPaneNodes, paneIdOfSurface, paneNodeById } from './pane-tree.js';
import { createRandomId } from '$lib/utils/random-id.js';
import {
	WorkspaceTransitionArbiter,
	type WorkspaceMutationPlan,
} from './workspace-transition-arbiter.js';
import type { ChatInteractionGate } from './chat-interaction-gate.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';
import type {
	FilePlacementPort,
	FilePlacementResult,
	FileSessionRegistry,
} from '$lib/files/sessions/file-session-registry.svelte.js';
import { fileSurfaceId } from './surface-types.js';
import type { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import type { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import type { SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import { FileDialogCoordinator } from './file-dialog-coordinator.js';
import { TerminalPlacementService } from './terminal-placement-service.js';
import type { WorkspaceCommitOptions } from './workspace-commit.js';
import { canOmitCanonicalPullRequests } from './canonical-layout.js';
import { WorkspacePresentationController } from './workspace-presentation-controller.svelte.js';

interface WorkspaceCoordinatorDeps {
	arbiter: WorkspaceTransitionArbiter;
	terminals: TerminalRegistry;
	workspaceContext: WorkspaceContextStore;
	appShell: AppShellStore;
	chatInteractionGate: ChatInteractionGate;
	transientLayers: TransientLayerRegistry;
	files: FileSessionRegistry;
	singletons: SingletonSurfaceRegistry;
	gitMutations?: GitMutationCoordinator;
	surfaceFrames?: SurfaceFrameRegistry;
	onLayoutChanged?(snapshot: WorkspaceLayoutSnapshot): void;
	onTerminalLauncherDismissed?(): void;
	getRouteIdentity(): string;
}

export class WorkspacePaneLimitError extends Error {
	constructor() {
		super(m.workspace_pane_limit_reached({ count: MAX_WORKSPACE_PANES }));
		this.name = 'WorkspacePaneLimitError';
	}
}

export class WorkspaceCoordinator implements FilePlacementPort {
	readonly #deps: WorkspaceCoordinatorDeps;
	#reservedSurfaceIds = new SvelteSet<string>();
	readonly #presentation: WorkspacePresentationController;
	readonly #fileDialog: FileDialogCoordinator;
	readonly #terminalPlacement: TerminalPlacementService;
	closeGuardRequest = $state<{
		surfaceId: string;
		title: string;
		description: string;
		confirmLabel: string;
	} | null>(null);
	#closeGuardResolve: ((confirmed: boolean) => void) | null = null;

	constructor(deps: WorkspaceCoordinatorDeps) {
		this.#deps = deps;
		this.#presentation = new WorkspacePresentationController({
			arbiter: deps.arbiter,
			terminals: deps.terminals,
			workspaceContext: deps.workspaceContext,
			appShell: deps.appShell,
			chatInteractionGate: deps.chatInteractionGate,
			transientLayers: deps.transientLayers,
			files: deps.files,
			singletons: deps.singletons,
			surfaceFrames: deps.surfaceFrames,
			onLayoutChanged: deps.onLayoutChanged,
			getRouteIdentity: deps.getRouteIdentity,
		});
		const commit = (mutations: WorkspaceMutationPlan, options?: WorkspaceCommitOptions) =>
			this.#presentation.commit(mutations, options);
		this.#fileDialog = new FileDialogCoordinator({
			layout: deps.arbiter.layout,
			files: deps.files,
			chatInteractionGate: deps.chatInteractionGate,
			reservations: this.#reservedSurfaceIds,
			commit,
			isMobile: () => this.isMobile,
			responsiveGeneration: () => this.#presentation.responsiveGeneration,
			defaultActiveId: () => this.defaultActiveId,
			lastFocusedSurfaceId: () => this.lastFocusedSurfaceId,
			paneOf: (surfaceId) => this.#presentation.paneOf(surfaceId),
			eligibleDesktopReturn: (surfaceId) => this.#presentation.eligibleDesktopReturn(surfaceId),
			present: (surfaceId) => this.#presentation.presentSurface(surfaceId),
			placeOnMobile: (sessionId, surfaceId, publication) =>
				this.#placeFileSessionOnMobile(sessionId, surfaceId, publication),
		});
		this.#terminalPlacement = new TerminalPlacementService({
			layout: deps.arbiter.layout,
			terminals: deps.terminals,
			reservations: this.#reservedSurfaceIds,
			commit,
			commitDestroyedRemoval: (surfaceId, mutations) =>
				this.#presentation.commitDestroyedRemovals([surfaceId], mutations),
			currentProjectPath: () => deps.workspaceContext.current?.projectPath ?? null,
			isMobile: () => this.isMobile,
			isChatPresented: () => this.isChatPresented,
			cancelChatTransition: () => deps.chatInteractionGate.cancelBeforeInertTransition(),
			paneOf: (surfaceId) => this.#presentation.paneOf(surfaceId),
			defaultPaneId: () => this.defaultPaneId,
			defaultActiveId: () => this.defaultActiveId,
			lastFocusedSurfaceId: () => this.lastFocusedSurfaceId,
			focusSurface: (surfaceId) => this.focusSurface(surfaceId),
			present: (surfaceId) => this.#presentation.presentSurface(surfaceId),
			resolveMobileReturn: (excluding, snapshot) =>
				this.#presentation.resolveMobileReturn(excluding, snapshot),
			confirmClose: (request) => this.#confirmClose(request),
			clearAttachmentError: (surfaceId) => this.#presentation.clearAttachmentError(surfaceId),
		});
	}

	get layout() {
		return this.#presentation.layout;
	}

	get lastFocusedSurfaceId(): string {
		return this.#presentation.lastFocusedSurfaceId;
	}

	set lastFocusedSurfaceId(surfaceId: string) {
		this.#presentation.lastFocusedSurfaceId = surfaceId;
	}

	get focusOwner(): FocusOwner {
		return this.#presentation.focusOwner;
	}

	set focusOwner(owner: FocusOwner) {
		this.#presentation.focusOwner = owner;
	}

	get isMobile(): boolean {
		return this.#presentation.isMobile;
	}

	isSurfacePresented(surfaceId: string): boolean {
		return this.#presentation.isSurfacePresented(surfaceId);
	}

	get defaultActiveId(): string {
		return this.#presentation.defaultActiveId;
	}

	get defaultPaneId(): PaneId {
		return this.layout.chatPaneId;
	}

	get lastFocusedPaneId(): PaneId {
		return this.#presentation.lastFocusedPaneId ?? this.defaultPaneId;
	}

	get paneCount(): number {
		return collectPaneNodes(this.layout.snapshot.desktopRoot).length;
	}

	get canSplitPane(): boolean {
		return this.paneCount < MAX_WORKSPACE_PANES;
	}

	get isChatPresented(): boolean {
		return this.#presentation.isChatPresented;
	}

	get isChatInteractive(): boolean {
		return this.#presentation.isChatInteractive;
	}

	// Active tab kind of the pane that most recently held focus. Drives
	// chrome that reacts to the focused view, like hiding the chat list
	// while a Git surface is active.
	get focusedPaneActiveKind(): ActiveSurfaceKind | null {
		const snapshot = this.layout.snapshot;
		const paneId =
			this.#presentation.paneOf(this.#presentation.lastFocusedSurfaceId) ?? this.defaultPaneId;
		const activeId = paneNodeById(snapshot.desktopRoot, paneId)?.tabs.activeId ?? null;
		const surface = activeId ? snapshot.surfaces[activeId] : null;
		if (!surface) return null;
		return surface.type === 'singleton' ? surface.kind : surface.type;
	}

	frameVersion(surfaceId: string): number {
		return this.#presentation.frameVersion(surfaceId);
	}

	get attachmentErrors(): Readonly<Record<string, string>> {
		return this.#presentation.attachmentErrors;
	}

	isSurfaceCloseBlocked(surfaceId: string): boolean {
		const surface = this.layout.surface(surfaceId);
		if (!surface || surfaceId === CHAT_SURFACE_ID || this.#reservedSurfaceIds.has(surfaceId)) {
			return true;
		}
		if (this.#deps.gitMutations?.pendingCount(surfaceId)) return true;
		if (surface.type === 'file') {
			return (this.#deps.files.get(surface.fileSessionId)?.pendingMutationCount ?? 0) > 0;
		}
		if (surface.type === 'singleton' && surface.kind === 'commit') {
			return !(this.#deps.singletons.commitIfPresent()?.canClose ?? true);
		}
		return false;
	}

	noteSurfaceFocus(surfaceId: string): void {
		this.#presentation.noteSurfaceFocus(surfaceId);
	}

	noteChatListFocus(): void {
		this.#presentation.noteChatListFocus();
	}

	notePaneChromeFocus(paneId: PaneId, surfaceId: string): void {
		this.#presentation.notePaneChromeFocus(paneId, surfaceId);
	}

	async focusChat(): Promise<void> {
		await this.#presentation.focusChat();
	}

	async focusSurface(surfaceId: string): Promise<void> {
		await this.#presentation.focusSurface(surfaceId, this.#reservedSurfaceIds);
	}

	focusPreviousTabInFocusedPane(owner: FocusOwner = this.focusOwner): boolean {
		return this.#presentation.focusPreviousTab(
			owner,
			(surfaceId) => void this.focusSurface(surfaceId),
		);
	}

	focusNextTabInFocusedPane(owner: FocusOwner = this.focusOwner): boolean {
		return this.#presentation.focusNextTab(owner, (surfaceId) => void this.focusSurface(surfaceId));
	}

	cyclePaneFocus(owner: FocusOwner = this.focusOwner): void {
		this.#presentation.cyclePaneFocus(owner, (surfaceId) => void this.focusSurface(surfaceId));
	}

	// Opens a singleton as a tab in the given pane, moving it there when it
	// already exists elsewhere.
	async openSingletonAsTab(kind: PortableSingletonKind, paneId: PaneId): Promise<void> {
		if (this.isMobile) {
			await this.focusMobileSingleton(kind);
			return;
		}
		const surfaceId = singletonSurfaceId(kind);
		const surface = this.layout.surface(surfaceId);
		if (surface) {
			const currentPaneId = this.#presentation.paneOf(surfaceId);
			if (currentPaneId === paneId) {
				await this.focusSurface(surfaceId);
				return;
			}
			if (this.isChatPresented) this.#deps.chatInteractionGate.cancelBeforeInertTransition();
			const current = await this.#presentation.commit((latest) =>
				latest.surfaces[surfaceId]
					? [{ type: 'move-tab', surfaceId, destinationPaneId: paneId }]
					: [],
			);
			if (!current) return;
			this.#presentation.presentSurface(surfaceId);
			return;
		}
		await this.#openSingleton(kind, (latest) => {
			if (!paneNodeById(latest.desktopRoot, paneId)) return [];
			return [
				{ type: 'register-surface', surface: portableSingletonDescriptor(kind), paneId },
				{ type: 'activate-pane-tab', paneId, surfaceId },
			];
		});
	}

	// Opens a singleton in a new pane split from the anchor pane. An existing
	// singleton that already owns a pane is focused; otherwise it is detached
	// into the new pane.
	async openSingletonInNewPane(
		kind: PortableSingletonKind,
		anchorPaneId?: PaneId,
	): Promise<void> {
		if (this.isMobile) {
			await this.focusMobileSingleton(kind);
			return;
		}
		const anchor = anchorPaneId ?? this.lastFocusedPaneId;
		const surfaceId = singletonSurfaceId(kind);
		const surface = this.layout.surface(surfaceId);
		if (surface) {
			const currentPaneId = this.#presentation.paneOf(surfaceId);
			if (!currentPaneId) {
				await this.focusSurface(surfaceId);
				return;
			}
			const currentPane = paneNodeById(this.layout.snapshot.desktopRoot, currentPaneId);
			if (currentPane && currentPane.tabs.order.length === 1) {
				await this.focusSurface(surfaceId);
				return;
			}
			if (!this.canSplitPane) throw new WorkspacePaneLimitError();
			await this.splitTabToEdge(surfaceId, anchor, 'right');
			return;
		}
		if (!this.canSplitPane) throw new WorkspacePaneLimitError();
		const newPaneId = `pane-${createRandomId()}` as PaneId;
		const splitId = `split-${createRandomId()}` as SplitId;
		await this.#openSingleton(kind, (latest) => {
			if (!paneNodeById(latest.desktopRoot, anchor)) return [];
			if (collectPaneNodes(latest.desktopRoot).length >= MAX_WORKSPACE_PANES) {
				throw new WorkspacePaneLimitError();
			}
			return [
				{
					type: 'register-surface-in-split',
					surface: portableSingletonDescriptor(kind),
					targetPaneId: anchor,
					edge: 'right',
					newPaneId,
					splitId,
				},
			];
		});
	}

	async #openSingleton(
		kind: PortableSingletonKind,
		plan: (latest: WorkspaceLayoutSnapshot) => readonly WorkspaceLayoutMutation[],
	): Promise<void> {
		const surfaceId = singletonSurfaceId(kind);
		if (this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const current = await this.#presentation.commit((latest) => {
			const existingPaneId = paneIdOfSurface(latest.desktopRoot, surfaceId);
			if (existingPaneId) {
				return [{ type: 'activate-pane-tab', paneId: existingPaneId, surfaceId }];
			}
			if (latest.surfaces[surfaceId]) {
				return [
					{
						type: 'move-tab',
						surfaceId,
						destinationPaneId: paneIdOfSurface(latest.desktopRoot, CHAT_SURFACE_ID) ?? this.defaultPaneId,
					},
				];
			}
			return plan(latest);
		});
		if (!current) return;
		this.#presentation.presentSurface(surfaceId);
	}

	async moveTabToPane(surfaceId: string, destinationPaneId: PaneId): Promise<void> {
		if (this.#reservedSurfaceIds.has(surfaceId)) return;
		if (this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const current = await this.#presentation.commit((latest) => {
			if (!latest.surfaces[surfaceId]) return [];
			if (!paneIdOfSurface(latest.desktopRoot, surfaceId)) return [];
			return [{ type: 'move-tab', surfaceId, destinationPaneId }];
		});
		if (!current) return;
		this.#presentation.presentSurface(surfaceId);
	}

	// Moves an existing tab into a new pane split from the target pane edge.
	async splitTabToEdge(
		surfaceId: string,
		targetPaneId: PaneId,
		edge: SplitEdge,
	): Promise<void> {
		if (this.#reservedSurfaceIds.has(surfaceId)) return;
		if (!this.canSplitPane) throw new WorkspacePaneLimitError();
		if (this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const newPaneId = `pane-${createRandomId()}` as PaneId;
		const splitId = `split-${createRandomId()}` as SplitId;
		const current = await this.#presentation.commit((latest) => {
			if (!latest.surfaces[surfaceId]) return [];
			if (!paneIdOfSurface(latest.desktopRoot, surfaceId)) return [];
			return [
				{
					type: 'split-tab-to-edge',
					surfaceId,
					targetPaneId,
					edge,
					newPaneId,
					splitId,
				},
			];
		});
		if (!current) return;
		this.#presentation.presentSurface(surfaceId);
	}

	// Collapses a pane, merging its tabs into the destination pane.
	async mergePaneInto(sourcePaneId: PaneId, destinationPaneId: PaneId): Promise<void> {
		if (this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const current = await this.#presentation.commit((latest) => {
			if (
				!paneNodeById(latest.desktopRoot, sourcePaneId) ||
				!paneNodeById(latest.desktopRoot, destinationPaneId)
			) {
				return [];
			}
			return [{ type: 'merge-pane', sourcePaneId, destinationPaneId }];
		});
		if (!current) return;
		const fallback = paneNodeById(this.layout.snapshot.desktopRoot, destinationPaneId)?.tabs
			.activeId;
		if (fallback) this.#presentation.presentSurface(fallback);
	}

	async setSplitRatio(splitId: SplitId, ratio: number): Promise<void> {
		await this.#presentation.commit([{ type: 'set-split-ratio', splitId, ratio }]);
	}

	async closeSurface(surfaceId: string): Promise<boolean> {
		const surface = this.layout.surface(surfaceId);
		if (!surface || this.isSurfaceCloseBlocked(surfaceId)) return false;
		this.#reservedSurfaceIds.add(surfaceId);
		try {
			if (surface.type === 'singleton' && surface.kind === 'commit') {
				const commit = this.#deps.singletons.commitIfPresent();
				if (commit && !commit.canClose) return false;
				const draftCount = commit?.retainedDraftCount ?? 0;
				if (
					draftCount > 0 &&
					!(await this.#confirmClose({
						surfaceId,
						title: m.commit_surface_close_title(),
						description:
							draftCount === 1
								? m.commit_surface_close_drafts_singular()
								: m.commit_surface_close_drafts_plural({ count: draftCount }),
						confirmLabel: m.commit_surface_discard_close(),
					}))
				)
					return false;
			}
			if (surface.type === 'file') {
				const canDestroy = await this.#deps.files.confirmDestructive(
					surface.fileSessionId,
					'close',
				);
				if (!canDestroy) return false;
			}
			const sourcePaneId = this.#presentation.paneOf(surfaceId);
			const wasDialog = this.layout.snapshot.dialogFileSurfaceId === surfaceId;
			let mobileFallbackId: string | null = null;
			const removalPlan = (latest: WorkspaceLayoutSnapshot): WorkspaceLayoutMutation[] => {
				if (!latest.surfaces[surfaceId]) return [];
				const mutations: WorkspaceLayoutMutation[] = [
					surface.type === 'terminal'
						? { type: 'unplace-terminal', terminalId: surface.terminalId }
						: { type: 'remove-surface', surfaceId },
				];
				if (this.isMobile && latest.mobileActiveSurfaceId === surfaceId) {
					const fallback = this.#presentation.resolveMobileReturn(surfaceId, latest);
					mobileFallbackId = fallback.activeId;
					mutations.push({
						type: 'set-mobile-presentation',
						activeId: fallback.activeId,
						returnStack: fallback.returnStack,
					});
				}
				return mutations;
			};
			const current =
				surface.type === 'terminal'
					? await this.#presentation.commit(removalPlan)
					: await this.#presentation.commitDestroyedRemovals([surfaceId], removalPlan);
			this.#presentation.clearAttachmentError(surfaceId);
			if (wasDialog) this.#fileDialog.clearReturnSurface();
			if (surface.type === 'file') this.#deps.files.destroy(surface.fileSessionId);
			if (surface.type === 'terminal-launcher') this.#deps.onTerminalLauncherDismissed?.();
			if (surface.type === 'singleton' && surface.kind !== 'chat') {
				if (surface.kind === 'commit') {
					this.#deps.singletons.commitIfPresent()?.discardDrafts();
				}
				this.#deps.singletons.disposeSurface(surface.kind);
			}
			if (!current) return true;
			const sourcePaneActive = sourcePaneId
				? paneNodeById(this.layout.snapshot.desktopRoot, sourcePaneId)?.tabs.activeId
				: null;
			const fallbackSurfaceId =
				mobileFallbackId ??
				(wasDialog
					? this.#presentation.eligibleDesktopReturn(this.#fileDialog.returnSurfaceId)
					: null) ??
				sourcePaneActive ??
				this.defaultActiveId;
			this.lastFocusedSurfaceId = fallbackSurfaceId;
			this.#presentation.focusPresentedSurface(fallbackSurfaceId);
			return true;
		} finally {
			this.#reservedSurfaceIds.delete(surfaceId);
			if (surface.type === 'terminal') {
				await this.#terminalPlacement.afterPlacementReleased(surface.terminalId);
			}
		}
	}

	async terminateTerminalSession(terminalId: string): Promise<boolean> {
		return this.#terminalPlacement.terminate(terminalId);
	}

	resolveCloseGuard(confirmed: boolean): void {
		const resolve = this.#closeGuardResolve;
		this.#closeGuardResolve = null;
		this.closeGuardRequest = null;
		resolve?.(confirmed);
	}

	async placeFileSession(
		sessionId: string,
		target?: DesktopPlacement,
		publication?: { publish(): void; rollback(): void },
	): Promise<FilePlacementResult> {
		const surfaceId = fileSurfaceId(sessionId);
		if (this.layout.surface(surfaceId)) {
			await this.focusFileSession(sessionId);
			return 'placed';
		}
		if (this.isMobile) {
			return this.#placeFileSessionOnMobile(sessionId, surfaceId, publication);
		}
		const destination = target ?? { type: 'dialog' as const };
		if (destination.type === 'dialog') {
			return this.#fileDialog.placeNew(sessionId, publication);
		}
		if (this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		if (destination.type === 'new-pane') {
			const anchor = destination.anchorPaneId;
			if (!this.canSplitPane) {
				return this.placeFileSession(sessionId, { type: 'pane', paneId: anchor }, publication);
			}
			const newPaneId = `pane-${createRandomId()}` as PaneId;
			const splitId = `split-${createRandomId()}` as SplitId;
			const plan = (latest: WorkspaceLayoutSnapshot): readonly WorkspaceLayoutMutation[] => {
				if (!paneNodeById(latest.desktopRoot, anchor)) return [];
				if (collectPaneNodes(latest.desktopRoot).length >= MAX_WORKSPACE_PANES) {
					return [
						{
							type: 'register-surface',
							surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
							paneId: anchor,
						},
						{ type: 'activate-pane-tab', paneId: anchor, surfaceId },
					];
				}
				return [
					{
						type: 'register-surface-in-split',
						surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
						targetPaneId: anchor,
						edge: 'right',
						newPaneId,
						splitId,
					},
				];
			};
			const current = await this.#presentation.commit(plan, { publication });
			if (current) this.#presentation.presentSurface(surfaceId);
			return 'placed';
		}
		const paneId = destination.paneId;
		const plan = (latest: WorkspaceLayoutSnapshot): readonly WorkspaceLayoutMutation[] => {
			if (!paneNodeById(latest.desktopRoot, paneId)) return [];
			return [
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
					paneId,
				},
				{ type: 'activate-pane-tab', paneId, surfaceId },
			];
		};
		const current = await this.#presentation.commit(plan, { publication });
		if (current) this.#presentation.presentSurface(surfaceId);
		return 'placed';
	}

	async focusFileSession(sessionId: string): Promise<void> {
		const surfaceId = fileSurfaceId(sessionId);
		if (this.layout.snapshot.dialogFileSurfaceId === surfaceId) {
			this.#presentation.presentSurface(surfaceId);
			return;
		}
		if (this.layout.snapshot.mobileOnlySurfaceIds.includes(surfaceId) || this.isMobile) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
			const returnStack = this.#presentation.returnStackForTransient(surfaceId);
			const current = await this.#presentation.commit([
				{
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack,
				},
			]);
			if (!current) return;
			this.#presentation.presentSurface(surfaceId);
			return;
		}
		await this.focusSurface(surfaceId);
	}

	async popOutFile(surfaceId: string): Promise<boolean> {
		const surface = this.layout.surface(surfaceId);
		if (!surface || surface.type !== 'file') return false;
		return this.#fileDialog.pop(surfaceId);
	}

	async moveDialogFileToPane(destinationPaneId: PaneId): Promise<void> {
		await this.#fileDialog.moveToPane(destinationPaneId);
	}

	async createTerminal(paneId: PaneId = this.defaultPaneId, requestKey?: string): Promise<string> {
		return this.#terminalPlacement.create(paneId, requestKey);
	}

	async createTerminalInNewPane(anchorPaneId?: PaneId, requestKey?: string): Promise<string> {
		if (!this.canSplitPane) throw new WorkspacePaneLimitError();
		return this.#terminalPlacement.createInNewPane(anchorPaneId ?? this.lastFocusedPaneId, requestKey);
	}

	async createTerminalReplacing(currentTerminalId: string, requestKey?: string): Promise<string> {
		return this.#terminalPlacement.createReplacing(currentTerminalId, requestKey);
	}

	async openTerminalSession(
		terminalId: string,
		preferredPaneId: PaneId = this.defaultPaneId,
	): Promise<void> {
		await this.#terminalPlacement.open(terminalId, preferredPaneId);
	}

	async switchTerminalSurface(currentTerminalId: string, nextTerminalId: string): Promise<void> {
		await this.#terminalPlacement.switch(currentTerminalId, nextTerminalId);
	}

	async handleTerminalSessionTerminated(terminalId: string): Promise<void> {
		await this.#terminalPlacement.handleTerminated(terminalId);
	}

	async focusMostRecentTerminalOrCreate(
		preferredPaneId: PaneId = this.defaultPaneId,
	): Promise<void> {
		await this.#terminalPlacement.focusMostRecentOrCreate(preferredPaneId);
	}

	async enterMobilePresentation(): Promise<void> {
		await this.#presentation.enterMobilePresentation();
	}

	async exitMobilePresentation(): Promise<void> {
		await this.#presentation.exitMobilePresentation();
	}

	async focusMobileSingleton(kind: PortableSingletonKind): Promise<void> {
		await this.#presentation.focusMobileSingleton(kind);
	}

	async mobileBack(): Promise<void> {
		await this.#presentation.mobileBack();
	}

	async toggleFullscreen(paneId: PaneId): Promise<void> {
		if (this.isMobile) return;
		const snapshot = this.layout.snapshot;
		if (!paneNodeById(snapshot.desktopRoot, paneId)) return;
		if (snapshot.fullscreenPaneId !== paneId && this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const current = await this.#presentation.commit((latest) => {
			if (!paneNodeById(latest.desktopRoot, paneId)) return [];
			return [
				{
					type: 'set-fullscreen-pane',
					paneId: latest.fullscreenPaneId === paneId ? null : paneId,
				},
			];
		});
		if (!current) return;
		const activeId = paneNodeById(this.layout.snapshot.desktopRoot, paneId)?.tabs.activeId;
		if (activeId) this.#presentation.presentSurface(activeId);
	}

	async retryPresentation(surfaceId: string, host: PresentationHostId): Promise<void> {
		await this.#presentation.retryPresentation(surfaceId, host);
	}

	async reconcileTerminals(
		liveTerminalIds: readonly string[],
		options: { deriveLauncher: boolean },
	): Promise<void> {
		await this.#terminalPlacement.reconcile(liveTerminalIds, options);
	}

	async omitCanonicalPullRequests(): Promise<void> {
		const snapshot = this.layout.snapshot;
		const pullRequestsSurfaceId = singletonSurfaceId('pull-requests');
		if (!canOmitCanonicalPullRequests(snapshot)) return;
		await this.#presentation.commit([{ type: 'remove-surface', surfaceId: pullRequestsSurfaceId }]);
	}

	async activateTerminalLauncher(paneId: PaneId): Promise<void> {
		await this.#terminalPlacement.activateLauncher(paneId);
	}

	#confirmClose(request: NonNullable<WorkspaceCoordinator['closeGuardRequest']>): Promise<boolean> {
		if (this.#closeGuardResolve) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			this.#deps.transientLayers.open('main-inert', () => {
				this.#closeGuardResolve = resolve;
				this.closeGuardRequest = request;
			});
		});
	}

	async #placeFileSessionOnMobile(
		sessionId: string,
		surfaceId: string,
		publication?: { publish(): void; rollback(): void },
	): Promise<FilePlacementResult> {
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		const returnStack = this.#presentation.returnStackForTransient(surfaceId);
		const current = await this.#presentation.commit(
			[
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
				},
				{
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack,
				},
			],
			{ publication },
		);
		if (current) this.#presentation.presentSurface(surfaceId);
		return 'placed';
	}
}
