import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import {
	WORKSPACE_WINDOW_RESOURCE_CEILING,
	chatViewSurfaceId,
	fileSurfaceId,
	portableSingletonDescriptor,
	singletonSurfaceId,
	workspaceChatViewCount,
	type ChatViewSurfaceId,
	type DesktopPlacement,
	type FocusOwner,
	type PortableSingletonKind,
	type PresentationHostId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
	type WorkspacePartitionId,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
} from './surface-types.js';
import { collectWindowNodes, windowIdOfSurface, windowNodeById } from './window-tree.js';
import { reduceWorkspaceLayout } from './workspace-layout.svelte.js';
import { createRandomId } from '$lib/utils/random-id.js';
import {
	WorkspaceTransitionArbiter,
	type WorkspaceMutationPlan,
} from './workspace-transition-arbiter.js';
import type { WorkspaceInteractionGate } from './workspace-interaction-gate.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';
import type {
	FilePlacementPort,
	FilePlacementResult,
	FileSessionRegistry,
} from '$lib/files/sessions/file-session-registry.svelte.js';
import type { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import type { SingletonSurfaceRegistry } from './singleton-surfaces.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import type { SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import { FileDialogCoordinator } from './file-dialog-coordinator.js';
import { TerminalPlacementService } from './terminal-placement-service.js';
import type { WorkspaceCommitOptions } from './workspace-commit.js';
import type { ChatSurfaceTransferPort } from './chat-surface-transfer.js';
import { WorkspacePresentationController } from './workspace-presentation-controller.svelte.js';
import { WorkspaceTabMovementService } from './workspace-tab-movement-service.js';
import { WorkspaceWindowDestructionService } from './workspace-window-destruction-service.js';
import type {
	WorkspacePartitionRatioBounds,
	WorkspacePartitionRatioBoundsResolver,
	WorkspaceSplitAdmission,
	WorkspaceSplitAdmissionResolver,
} from './window-geometry-policy.js';

interface WorkspaceCoordinatorDeps {
	arbiter: WorkspaceTransitionArbiter;
	terminals: TerminalRegistry;
	workspaceContext: WorkspaceContextStore;
	appShell: AppShellStore;
	workspaceInteractionGate: WorkspaceInteractionGate;
	transientLayers: TransientLayerRegistry;
	files: FileSessionRegistry;
	singletons: SingletonSurfaceRegistry;
	gitMutations?: GitMutationCoordinator;
	surfaceFrames?: SurfaceFrameRegistry;
	resolveSplitAdmission: WorkspaceSplitAdmissionResolver;
	resolvePartitionRatioBounds: WorkspacePartitionRatioBoundsResolver;
	onLayoutChanged?(snapshot: WorkspaceLayoutSnapshot): void;
	onTerminalLauncherDismissed?(): void;
	getRouteIdentity(): string;
}

export class WorkspaceWindowLimitError extends Error {
	constructor() {
		super(m.workspace_window_limit_reached({ count: WORKSPACE_WINDOW_RESOURCE_CEILING }));
		this.name = 'WorkspaceWindowLimitError';
	}
}

export class WorkspaceCoordinator implements FilePlacementPort {
	readonly #deps: WorkspaceCoordinatorDeps;
	#reservedSurfaceIds = new SvelteSet<string>();
	#reservedWindowIds = new SvelteSet<WorkspaceWindowId>();
	readonly #presentation: WorkspacePresentationController;
	readonly #fileDialog: FileDialogCoordinator;
	readonly #terminalPlacement: TerminalPlacementService;
	readonly #tabMovement: WorkspaceTabMovementService;
	readonly #windowDestruction: WorkspaceWindowDestructionService;
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
			workspaceInteractionGate: deps.workspaceInteractionGate,
			transientLayers: deps.transientLayers,
			files: deps.files,
			singletons: deps.singletons,
			surfaceFrames: deps.surfaceFrames,
			onLayoutChanged: deps.onLayoutChanged,
			getRouteIdentity: deps.getRouteIdentity,
		});
		const commit = (mutations: WorkspaceMutationPlan, options?: WorkspaceCommitOptions) =>
			this.#presentation.commit(mutations, options);
		this.#tabMovement = new WorkspaceTabMovementService({
			layout: deps.arbiter.layout,
			surfaceReservations: this.#reservedSurfaceIds,
			windowReservations: this.#reservedWindowIds,
			isMobile: () => this.isMobile,
			cancelWorkspaceDrag: () => deps.workspaceInteractionGate.cancelBeforeInertTransition(),
			commitWithPresentationTarget: (mutations, resolveTarget, options) =>
				this.#presentation.commitWithPresentationTarget(mutations, resolveTarget, options),
			createWindowLimitError: () => new WorkspaceWindowLimitError(),
			present: (surfaceId) => this.#presentation.presentSurface(surfaceId),
		});
		this.#fileDialog = new FileDialogCoordinator({
			layout: deps.arbiter.layout,
			files: deps.files,
			workspaceInteractionGate: deps.workspaceInteractionGate,
			reservations: this.#reservedSurfaceIds,
			commit,
			isWindowReserved: (windowId) => this.#reservedWindowIds.has(windowId),
			isMobile: () => this.isMobile,
			responsiveGeneration: () => this.#presentation.responsiveGeneration,
			defaultActiveId: () => this.defaultActiveId,
			lastFocusedSurfaceId: () => this.lastFocusedSurfaceId,
			windowOf: (surfaceId) => this.#presentation.windowOf(surfaceId),
			eligibleDesktopReturn: (surfaceId) => this.#presentation.eligibleDesktopReturn(surfaceId),
			present: (surfaceId) => this.#presentation.presentSurface(surfaceId),
			placeOnMobile: (sessionId, surfaceId, publication) =>
				this.#placeFileSessionOnMobile(sessionId, surfaceId, publication),
		});
		this.#terminalPlacement = new TerminalPlacementService({
			layout: deps.arbiter.layout,
			terminals: deps.terminals,
			reservations: this.#reservedSurfaceIds,
			isWindowReserved: (windowId) => this.#reservedWindowIds.has(windowId),
			commit,
			commitDestroyedRemoval: (surfaceId, mutations) =>
				this.#presentation.commitDestroyedRemovals([surfaceId], mutations),
			currentProjectPath: () => deps.workspaceContext.current?.projectPath ?? null,
			isMobile: () => this.isMobile,
			cancelWorkspaceDrag: () => deps.workspaceInteractionGate.cancelBeforeInertTransition(),
			windowOf: (surfaceId) => this.#presentation.windowOf(surfaceId),
			defaultWindowId: () => this.defaultWindowId,
			defaultActiveId: () => this.defaultActiveId,
			lastFocusedSurfaceId: () => this.lastFocusedSurfaceId,
			focusSurface: (surfaceId) => this.focusSurface(surfaceId),
			present: (surfaceId) => this.#presentation.presentSurface(surfaceId),
			resolveMobileReturn: (excluding, snapshot, sourceSnapshot) =>
				this.#presentation.resolveMobileReturn(excluding, snapshot, sourceSnapshot),
			confirmClose: (request) => this.#confirmClose(request),
			clearAttachmentError: (surfaceId) => this.#presentation.clearAttachmentError(surfaceId),
		});
		this.#windowDestruction = new WorkspaceWindowDestructionService({
			layout: deps.arbiter.layout,
			files: deps.files,
			singletons: deps.singletons,
			gitMutations: deps.gitMutations,
			surfaceReservations: this.#reservedSurfaceIds,
			windowReservations: this.#reservedWindowIds,
			commitDestroyedRemovals: (surfaceIds, plan) =>
				this.#presentation.commitDestroyedRemovals(surfaceIds, plan),
			confirmClose: (request) => this.#confirmClose(request),
			clearAttachmentError: (surfaceId) => this.#presentation.clearAttachmentError(surfaceId),
			afterTerminalReleased: (terminalId) =>
				this.#terminalPlacement.afterPlacementReleased(terminalId),
			onTerminalLauncherDismissed: deps.onTerminalLauncherDismissed,
			present: (surfaceId) => this.#presentation.presentSurface(surfaceId),
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

	get defaultActiveId(): string {
		return this.#presentation.defaultActiveId;
	}

	get defaultWindowId(): WorkspaceWindowId {
		return this.#presentation.defaultWindowId;
	}

	get currentWindowId(): WorkspaceWindowId {
		return this.#presentation.currentWindowId;
	}

	get currentChatSurfaceId(): `chat-view:${WorkspaceWindowId}` {
		const mobileSurface = this.layout.snapshot.surfaces[this.layout.snapshot.mobileActiveSurfaceId];
		if (this.isMobile && mobileSurface?.type === 'chat') return mobileSurface.id;
		const workspaceWindow = windowNodeById(this.layout.snapshot.desktopRoot, this.currentWindowId);
		const activeSurface = workspaceWindow
			? this.layout.snapshot.surfaces[workspaceWindow.tabs.activeId]
			: null;
		return activeSurface?.type === 'chat'
			? activeSurface.id
			: chatViewSurfaceId(this.currentWindowId);
	}

	get composerAnchorSurfaceId(): ChatViewSurfaceId | null {
		return this.#presentation.composerAnchorSurfaceId;
	}

	get lastFocusedWindowId(): WorkspaceWindowId {
		return this.#resolveWindowId(this.layout.snapshot, this.#presentation.lastFocusedWindowId);
	}

	get windowCount(): number {
		return collectWindowNodes(this.layout.snapshot.desktopRoot).length;
	}

	registerChatSurfaceTransferPort(port: ChatSurfaceTransferPort): () => void {
		return this.#tabMovement.registerChatSurfaceTransferPort(port);
	}

	get canOpenNewWindow(): boolean {
		return this.windowCount < WORKSPACE_WINDOW_RESOURCE_CEILING;
	}

	resolveSplitAdmission(
		targetWindowId: WorkspaceWindowId,
		edge: WorkspaceWindowEdge,
		movingSurfaceId?: string,
	): WorkspaceSplitAdmission | null {
		return this.#deps.resolveSplitAdmission(this.layout.snapshot, {
			targetWindowId,
			edge,
			movingSurfaceId,
		});
	}

	resolvePartitionRatioBounds(
		partitionId: WorkspacePartitionId,
	): WorkspacePartitionRatioBounds | null {
		return (
			this.#deps.resolvePartitionRatioBounds(this.layout.snapshot, partitionId)?.bounds ?? null
		);
	}

	get isChatPresented(): boolean {
		return this.#presentation.isChatPresented;
	}

	get isChatInteractive(): boolean {
		return this.#presentation.isChatInteractive;
	}

	isSurfacePresented(surfaceId: string): boolean {
		return this.#presentation.isSurfacePresented(surfaceId);
	}

	windowOf(surfaceId: string): WorkspaceWindowId | null {
		return this.#presentation.windowOf(surfaceId);
	}
	frameVersion(surfaceId: string): number {
		return this.#presentation.frameVersion(surfaceId);
	}

	get attachmentErrors(): Readonly<Record<string, string>> {
		return this.#presentation.attachmentErrors;
	}

	isSurfaceCloseBlocked(surfaceId: string): boolean {
		const surface = this.layout.surface(surfaceId);
		if (!surface || this.#reservedSurfaceIds.has(surfaceId)) return true;
		if (surface.type === 'chat' && workspaceChatViewCount(this.layout.snapshot) <= 1) {
			return true;
		}
		const ownerWindowId = windowIdOfSurface(this.layout.snapshot.desktopRoot, surfaceId);
		if (ownerWindowId && this.#reservedWindowIds.has(ownerWindowId)) return true;
		if (ownerWindowId) {
			const owner = windowNodeById(this.layout.snapshot.desktopRoot, ownerWindowId);
			if (owner?.tabs.order.length === 1 && this.windowCount === 1) return true;
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

	isWindowCloseBlocked(windowId: WorkspaceWindowId): boolean {
		return this.windowCount === 1 || this.#windowDestruction.isWindowBlocked(windowId);
	}

	noteSurfaceFocus(surfaceId: string): void {
		this.#presentation.noteSurfaceFocus(surfaceId);
	}

	noteChatListFocus(): void {
		this.#presentation.noteChatListFocus();
	}

	noteWindowChromeFocus(windowId: WorkspaceWindowId, surfaceId: string): void {
		this.#presentation.noteWindowChromeFocus(windowId, surfaceId);
	}

	beginWindowPointerInteraction(windowId: WorkspaceWindowId, pointerId: number): void {
		this.#presentation.beginWindowPointerInteraction(windowId, pointerId);
	}

	commitWindowPointerInteraction(windowId: WorkspaceWindowId): void {
		this.#presentation.commitWindowPointerInteraction(windowId);
	}

	releaseWindowPointerInteraction(windowId: WorkspaceWindowId, pointerId: number): void {
		this.#presentation.releaseWindowPointerInteraction(windowId, pointerId);
	}

	cancelWindowPointerInteraction(windowId: WorkspaceWindowId, pointerId: number): void {
		this.#presentation.cancelWindowPointerInteraction(windowId, pointerId);
	}

	cancelPendingWindowPointerInteraction(): void {
		this.#presentation.cancelPendingWindowPointerInteraction();
	}

	activateWindow(windowId: WorkspaceWindowId): void {
		this.#presentation.activateWindow(windowId);
	}

	async focusChat(): Promise<void> {
		await this.#presentation.focusChat();
	}

	async focusSurface(surfaceId: string): Promise<void> {
		await this.#presentation.focusSurface(surfaceId, this.#reservedSurfaceIds);
	}

	focusPreviousTabInFocusedWindow(owner: FocusOwner = this.focusOwner): boolean {
		return this.#presentation.focusPreviousTab(
			owner,
			(surfaceId) => void this.focusSurface(surfaceId),
		);
	}

	focusNextTabInFocusedWindow(owner: FocusOwner = this.focusOwner): boolean {
		return this.#presentation.focusNextTab(owner, (surfaceId) => void this.focusSurface(surfaceId));
	}

	cycleWindowFocus(owner: FocusOwner = this.focusOwner): void {
		this.#presentation.cycleWindowFocus(owner, (surfaceId) => void this.focusSurface(surfaceId));
	}

	async showChatInCurrentWindow(chatId: string): Promise<ChatViewSurfaceId> {
		const intendedWindowId = this.currentWindowId;
		return this.#showChat(chatId, (latest) =>
			windowNodeById(latest.desktopRoot, intendedWindowId)
				? intendedWindowId
				: this.#resolveWindowId(latest, this.#presentation.lastFocusedWindowId),
		);
	}

	async showChatInWindow(chatId: string, windowId: WorkspaceWindowId): Promise<ChatViewSurfaceId> {
		return this.#showChat(chatId, (latest) =>
			windowNodeById(latest.desktopRoot, windowId) ? windowId : null,
		);
	}

	async #showChat(
		chatId: string,
		resolveWindow: (snapshot: WorkspaceLayoutSnapshot) => WorkspaceWindowId | null,
	): Promise<ChatViewSurfaceId> {
		let surfaceId: ChatViewSurfaceId | null = null;
		let applied = false;
		const current = await this.#presentation.commitWithPresentationTarget(
			(latest) => {
				const destinationWindowId = resolveWindow(latest);
				if (!destinationWindowId || this.#reservedWindowIds.has(destinationWindowId)) return [];
				const destinationSurfaceId = chatViewSurfaceId(destinationWindowId);
				if (this.#reservedSurfaceIds.has(destinationSurfaceId)) return [];
				surfaceId = destinationSurfaceId;
				applied = true;
				const mutations: WorkspaceLayoutMutation[] = [
					{ type: 'set-window-chat', windowId: destinationWindowId, chatId },
				];
				if (this.isMobile) {
					mutations.push({
						type: 'set-mobile-presentation',
						activeId: destinationSurfaceId,
						returnStack: [],
					});
				}
				return mutations;
			},
			() => (applied ? surfaceId : null),
		);
		if (!applied || !surfaceId) throw new Error(m.workspace_open_failed());
		if (current) this.#presentation.presentSurface(surfaceId);
		return surfaceId;
	}

	async openChatInNewWindow(
		chatId: string,
		targetWindowId?: WorkspaceWindowId,
		edge: WorkspaceWindowEdge = 'right',
	): Promise<WorkspaceWindowId> {
		if (this.isMobile) {
			await this.showChatInCurrentWindow(chatId);
			return this.currentWindowId;
		}
		const newWindowId = `window-${createRandomId()}` as WorkspaceWindowId;
		const partitionId = `partition-${createRandomId()}` as WorkspacePartitionId;
		let opened = false;
		const current = await this.#presentation.commit((latest) => {
			if (collectWindowNodes(latest.desktopRoot).length >= WORKSPACE_WINDOW_RESOURCE_CEILING) {
				throw new WorkspaceWindowLimitError();
			}
			const anchor = this.#resolveWindowId(
				latest,
				targetWindowId ?? this.#presentation.lastFocusedWindowId,
			);
			if (this.#reservedWindowIds.has(anchor)) return [];
			opened = true;
			return [
				{
					type: 'open-chat-in-new-window',
					chatId,
					targetWindowId: anchor,
					edge,
					newWindowId,
					partitionId,
				},
			];
		});
		if (!opened || !this.layout.surface(chatViewSurfaceId(newWindowId))) {
			throw new Error(m.workspace_open_failed());
		}
		if (current) this.#presentation.presentSurface(chatViewSurfaceId(newWindowId));
		return newWindowId;
	}

	async clearDeletedChat(chatId: string): Promise<void> {
		await this.#presentation.commit((latest) =>
			collectWindowNodes(latest.desktopRoot).flatMap((workspaceWindow) => {
				const surfaceId = chatViewSurfaceId(workspaceWindow.id);
				const surface = latest.surfaces[surfaceId];
				return surface?.type === 'chat' && surface.chatId === chatId
					? [{ type: 'set-window-chat' as const, windowId: workspaceWindow.id, chatId: null }]
					: [];
			}),
		);
	}

	async openSingletonAsTab(
		kind: PortableSingletonKind,
		windowId: WorkspaceWindowId,
	): Promise<void> {
		const surfaceId = singletonSurfaceId(kind);
		if (this.#reservedSurfaceIds.has(surfaceId)) return;
		if (this.isMobile) {
			await this.focusMobileSingleton(kind);
			return;
		}
		this.#deps.workspaceInteractionGate.cancelBeforeInertTransition();
		const current = await this.#presentation.commit((latest) => {
			if (!windowNodeById(latest.desktopRoot, windowId) || this.#reservedWindowIds.has(windowId)) {
				return [];
			}
			const existingWindowId = windowIdOfSurface(latest.desktopRoot, surfaceId);
			if (existingWindowId === windowId) {
				return [{ type: 'activate-window-tab', windowId, surfaceId }];
			}
			if (latest.surfaces[surfaceId]) {
				return [{ type: 'move-tab', surfaceId, destinationWindowId: windowId }];
			}
			return [
				{
					type: 'register-surface',
					surface: portableSingletonDescriptor(kind),
					windowId,
				},
				{ type: 'activate-window-tab', windowId, surfaceId },
			];
		});
		if (current && this.layout.surface(surfaceId)) this.#presentation.presentSurface(surfaceId);
	}

	async openSingletonInNewWindow(
		kind: PortableSingletonKind,
		anchorWindowId?: WorkspaceWindowId,
	): Promise<void> {
		if (this.isMobile) {
			await this.focusMobileSingleton(kind);
			return;
		}
		const surfaceId = singletonSurfaceId(kind);
		if (this.#reservedSurfaceIds.has(surfaceId)) return;
		if (this.layout.surface(surfaceId)) {
			await this.focusSurface(surfaceId);
			return;
		}
		const newWindowId = `window-${createRandomId()}` as WorkspaceWindowId;
		const partitionId = `partition-${createRandomId()}` as WorkspacePartitionId;
		this.#deps.workspaceInteractionGate.cancelBeforeInertTransition();
		const current = await this.#presentation.commit((latest) => {
			if (latest.surfaces[surfaceId] || this.#reservedSurfaceIds.has(surfaceId)) return [];
			if (collectWindowNodes(latest.desktopRoot).length >= WORKSPACE_WINDOW_RESOURCE_CEILING) {
				throw new WorkspaceWindowLimitError();
			}
			if (
				collectWindowNodes(latest.desktopRoot).every((workspaceWindow) =>
					this.#reservedWindowIds.has(workspaceWindow.id),
				)
			) {
				return [];
			}
			const anchor = this.#resolveWindowId(
				latest,
				anchorWindowId ?? this.#presentation.lastFocusedWindowId,
			);
			if (this.#reservedWindowIds.has(anchor)) return [];
			return [
				{
					type: 'register-surface-in-new-window',
					surface: portableSingletonDescriptor(kind),
					targetWindowId: anchor,
					edge: 'right',
					newWindowId,
					partitionId,
				},
			];
		});
		if (current && this.layout.surface(surfaceId)) this.#presentation.presentSurface(surfaceId);
	}

	moveTabToWindow(
		surfaceId: string,
		destinationWindowId: WorkspaceWindowId,
		index?: number,
	): Promise<void> {
		return this.#tabMovement.moveToWindow(surfaceId, destinationWindowId, index);
	}

	moveTabToNewWindow(
		surfaceId: string,
		targetWindowId: WorkspaceWindowId,
		edge: WorkspaceWindowEdge,
	): Promise<void> {
		return this.#tabMovement.moveToNewWindow(surfaceId, targetWindowId, edge);
	}

	async setPartitionRatio(partitionId: WorkspacePartitionId, ratio: number): Promise<void> {
		await this.#presentation.commit([{ type: 'set-partition-ratio', partitionId, ratio }]);
	}

	async closeSurface(surfaceId: string): Promise<boolean> {
		const surface = this.layout.surface(surfaceId);
		if (!surface || this.isSurfaceCloseBlocked(surfaceId)) return false;
		const ownedFocus =
			this.focusOwner.kind !== 'chat-list' && this.focusOwner.surfaceId === surfaceId;
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
				) {
					return false;
				}
			}
			if (surface.type === 'file') {
				if (!(await this.#deps.files.confirmDestructive(surface.fileSessionId, 'close')))
					return false;
			}
			const sourceWindowId = this.#presentation.windowOf(surfaceId);
			const wasDialog = this.layout.snapshot.dialogFileSurfaceId === surfaceId;
			const dialogReturnSurfaceId = wasDialog ? this.#fileDialog.returnSurfaceId : null;
			let mobileFallbackId: string | null = null;
			let removalBlocked = false;
			const removalPlan = (latest: WorkspaceLayoutSnapshot): WorkspaceLayoutMutation[] => {
				if (!latest.surfaces[surfaceId]) return [];
				if (surface.type === 'chat' && workspaceChatViewCount(latest) <= 1) {
					removalBlocked = true;
					return [];
				}
				const removalMutation: WorkspaceLayoutMutation =
					surface.type === 'terminal'
						? { type: 'unplace-terminal', terminalId: surface.terminalId }
						: { type: 'remove-surface', surfaceId };
				const mutations: WorkspaceLayoutMutation[] = [removalMutation];
				if (this.isMobile && latest.mobileActiveSurfaceId === surfaceId) {
					// Uses post-removal availability while retaining the source-window topology.
					const fallback = this.#presentation.resolveMobileReturn(
						surfaceId,
						reduceWorkspaceLayout(latest, [removalMutation]),
						latest,
					);
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
			if (removalBlocked) return false;
			this.#presentation.clearAttachmentError(surfaceId);
			if (wasDialog) this.#fileDialog.clearReturnSurface();
			if (surface.type === 'file') this.#deps.files.destroy(surface.fileSessionId);
			if (surface.type === 'terminal-launcher') this.#deps.onTerminalLauncherDismissed?.();
			if (surface.type === 'singleton') {
				if (surface.kind === 'commit') this.#deps.singletons.commitIfPresent()?.discardDrafts();
				this.#deps.singletons.disposeSurface(surface.kind);
			}
			if (!current) return true;
			const shouldRestorePresentation = ownedFocus || wasDialog || mobileFallbackId !== null;
			if (!shouldRestorePresentation) return true;
			const sourceWindowActive = sourceWindowId
				? windowNodeById(this.layout.snapshot.desktopRoot, sourceWindowId)?.tabs.activeId
				: null;
			const fallbackSurfaceId =
				mobileFallbackId ??
				(wasDialog ? this.#presentation.eligibleDesktopReturn(dialogReturnSurfaceId) : null) ??
				sourceWindowActive ??
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

	async closeWindow(windowId: WorkspaceWindowId): Promise<boolean> {
		return this.#windowDestruction.close(windowId);
	}

	async enterWindowFullscreen(windowId: WorkspaceWindowId): Promise<boolean> {
		if (this.isMobile) return false;
		if (this.layout.snapshot.fullscreenWindowId === windowId) return true;
		this.#deps.workspaceInteractionGate.cancelBeforeInertTransition();
		let applied = false;
		const current = await this.#presentation.commit((latest) => {
			if (!windowNodeById(latest.desktopRoot, windowId)) return [];
			applied = true;
			return [{ type: 'set-fullscreen-window', windowId }];
		});
		if (!applied) return false;
		if (current) {
			const activeId = windowNodeById(this.layout.snapshot.desktopRoot, windowId)?.tabs.activeId;
			if (activeId) this.#presentation.presentSurface(activeId);
		}
		return true;
	}

	async exitWindowFullscreen(windowId: WorkspaceWindowId): Promise<void> {
		if (this.isMobile || this.layout.snapshot.fullscreenWindowId !== windowId) return;
		const current = await this.#presentation.commit((latest) =>
			latest.fullscreenWindowId === windowId
				? [{ type: 'set-fullscreen-window', windowId: null }]
				: [],
		);
		if (current) {
			const activeId = windowNodeById(this.layout.snapshot.desktopRoot, windowId)?.tabs.activeId;
			if (activeId) this.#presentation.presentSurface(activeId);
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
		if (this.isMobile) return this.#placeFileSessionOnMobile(sessionId, surfaceId, publication);
		const destination = target ?? { type: 'dialog' as const };
		if (destination.type === 'dialog') return this.#fileDialog.placeNew(sessionId, publication);
		this.#deps.workspaceInteractionGate.cancelBeforeInertTransition();
		if (destination.type === 'new-window') {
			const newWindowId = `window-${createRandomId()}` as WorkspaceWindowId;
			const partitionId = `partition-${createRandomId()}` as WorkspacePartitionId;
			const current = await this.#presentation.commit(
				(latest) => {
					if (collectWindowNodes(latest.desktopRoot).length >= WORKSPACE_WINDOW_RESOURCE_CEILING) {
						throw new WorkspaceWindowLimitError();
					}
					const anchor = this.#resolveWindowId(latest, destination.anchorWindowId);
					if (this.#reservedWindowIds.has(anchor)) return [];
					return [
						{
							type: 'register-surface-in-new-window',
							surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
							targetWindowId: anchor,
							edge: 'right',
							newWindowId,
							partitionId,
						},
					];
				},
				{ publication },
			);
			if (!this.layout.surface(surfaceId))
				throw new Error(`File surface was not placed: ${surfaceId}`);
			if (current) this.#presentation.presentSurface(surfaceId);
			return 'placed';
		}
		const current = await this.#presentation.commit(
			(latest) => {
				const windowId = this.#resolveWindowId(latest, destination.windowId);
				if (this.#reservedWindowIds.has(windowId)) return [];
				return [
					{
						type: 'register-surface',
						surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
						windowId,
					},
					{ type: 'activate-window-tab', windowId, surfaceId },
				];
			},
			{ publication },
		);
		if (!this.layout.surface(surfaceId))
			throw new Error(`File surface was not placed: ${surfaceId}`);
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
			this.#deps.workspaceInteractionGate.cancelBeforeInertTransition();
			const returnStack = this.#presentation.returnStackForTransient(surfaceId);
			const current = await this.#presentation.commit([
				{ type: 'set-mobile-presentation', activeId: surfaceId, returnStack },
			]);
			if (current) this.#presentation.presentSurface(surfaceId);
			return;
		}
		await this.focusSurface(surfaceId);
	}

	async popOutFile(surfaceId: string): Promise<boolean> {
		const surface = this.layout.surface(surfaceId);
		if (!surface || surface.type !== 'file') return false;
		return this.#fileDialog.pop(surfaceId);
	}

	async moveDialogFileToWindow(destinationWindowId: WorkspaceWindowId): Promise<void> {
		await this.#fileDialog.moveToWindow(destinationWindowId);
	}

	async createTerminal(
		windowId: WorkspaceWindowId = this.defaultWindowId,
		requestKey?: string,
	): Promise<string> {
		return this.#terminalPlacement.create(windowId, requestKey);
	}

	async createTerminalInNewWindow(
		anchorWindowId?: WorkspaceWindowId,
		requestKey?: string,
	): Promise<string> {
		if (this.isMobile) return this.#terminalPlacement.create(this.defaultWindowId, requestKey);
		return this.#terminalPlacement.createInNewWindow(
			anchorWindowId ?? this.lastFocusedWindowId,
			requestKey,
		);
	}

	async createTerminalReplacing(currentTerminalId: string, requestKey?: string): Promise<string> {
		return this.#terminalPlacement.createReplacing(currentTerminalId, requestKey);
	}

	async openTerminalSession(
		terminalId: string,
		preferredWindowId: WorkspaceWindowId = this.defaultWindowId,
	): Promise<void> {
		await this.#terminalPlacement.open(terminalId, preferredWindowId);
	}

	async switchTerminalSurface(currentTerminalId: string, nextTerminalId: string): Promise<void> {
		await this.#terminalPlacement.switch(currentTerminalId, nextTerminalId);
	}

	async handleTerminalSessionTerminated(terminalId: string): Promise<void> {
		await this.#terminalPlacement.handleTerminated(terminalId);
	}

	async focusMostRecentTerminalOrCreate(
		preferredWindowId: WorkspaceWindowId = this.defaultWindowId,
	): Promise<void> {
		await this.#terminalPlacement.focusMostRecentOrCreate(preferredWindowId);
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

	async retryPresentation(surfaceId: string, host: PresentationHostId): Promise<void> {
		await this.#presentation.retryPresentation(surfaceId, host);
	}

	async reconcileTerminals(
		liveTerminalIds: readonly string[],
		options: { deriveLauncher: boolean },
	): Promise<void> {
		await this.#terminalPlacement.reconcile(liveTerminalIds, options);
	}

	async activateTerminalLauncher(windowId: WorkspaceWindowId): Promise<void> {
		await this.#terminalPlacement.activateLauncher(windowId);
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
		this.#deps.workspaceInteractionGate.cancelBeforeInertTransition();
		const returnStack = this.#presentation.returnStackForTransient(surfaceId);
		const current = await this.#presentation.commit(
			[
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
				},
				{ type: 'set-mobile-presentation', activeId: surfaceId, returnStack },
			],
			{ publication },
		);
		if (current) this.#presentation.presentSurface(surfaceId);
		return 'placed';
	}

	#resolveWindowId(
		snapshot: WorkspaceLayoutSnapshot,
		preferredWindowId: WorkspaceWindowId | null | undefined,
	): WorkspaceWindowId {
		if (
			preferredWindowId &&
			windowNodeById(snapshot.desktopRoot, preferredWindowId) &&
			!this.#reservedWindowIds.has(preferredWindowId)
		) {
			return preferredWindowId;
		}
		const lastFocusedWindowId = this.#presentation.lastFocusedWindowId;
		if (
			lastFocusedWindowId &&
			windowNodeById(snapshot.desktopRoot, lastFocusedWindowId) &&
			!this.#reservedWindowIds.has(lastFocusedWindowId)
		) {
			return lastFocusedWindowId;
		}
		const first = collectWindowNodes(snapshot.desktopRoot).find(
			(workspaceWindow) => !this.#reservedWindowIds.has(workspaceWindow.id),
		);
		if (!first) throw new Error('Workspace has no destination window');
		return first.id;
	}
}
