import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import type { SingletonSurfaceRegistry } from './singleton-surfaces.svelte.js';
import type { SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import type { ChatInteractionGate } from './chat-interaction-gate.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import type { WorkspaceCommitOptions } from './workspace-commit.js';
import { MobilePresentationPlanner } from './mobile-presentation-planner.js';
import { selectMobileEntrySurface } from './responsive-handoff.js';
import {
	CHAT_SURFACE_ID,
	PORTABLE_SINGLETON_KINDS,
	isTransientMobileSingletonKind,
	portableSingletonDescriptor,
	singletonSurfaceId,
	type FocusOwner,
	type PaneId,
	type PortableSingletonKind,
	type PresentationHostId,
	type TransientMobileSingletonKind,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';
import { collectPaneNodes, paneIdOfSurface, paneNodeById } from './pane-tree.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';
import { WorkspaceTransitionArbiter } from './workspace-transition-arbiter.js';
import { isDesktopPanePresented, visiblePresentationMap } from './visible-presentations.js';
import { WorkspacePresentationFrames } from './workspace-presentation-frames.svelte.js';

type PresentationMode = 'desktop' | 'mobile';

interface WorkspacePresentationControllerDeps {
	arbiter: WorkspaceTransitionArbiter;
	terminals: TerminalRegistry;
	workspaceContext: WorkspaceContextStore;
	appShell: AppShellStore;
	chatInteractionGate: ChatInteractionGate;
	transientLayers: TransientLayerRegistry;
	files: FileSessionRegistry;
	singletons: SingletonSurfaceRegistry;
	surfaceFrames?: SurfaceFrameRegistry;
	onLayoutChanged?(snapshot: WorkspaceLayoutSnapshot): void;
	getRouteIdentity(): string;
}

class WorkspacePublicationInvariantError extends Error {
	constructor(
		message = 'Workspace transition arbitration failed to publish a serialized layout update',
	) {
		super(message);
		this.name = 'WorkspacePublicationInvariantError';
	}
}

function transientMobileGitViewKinds(
	snapshot: WorkspaceLayoutSnapshot,
): TransientMobileSingletonKind[] {
	return snapshot.mobileOnlySurfaceIds.flatMap((surfaceId) => {
		const surface = snapshot.surfaces[surfaceId];
		return surface?.type === 'singleton' &&
			surface.kind !== 'chat' &&
			isTransientMobileSingletonKind(surface.kind)
			? [surface.kind]
			: [];
	});
}

function removeTransientMobileGitViews(
	snapshot: WorkspaceLayoutSnapshot,
): WorkspaceLayoutMutation[] {
	return transientMobileGitViewKinds(snapshot).map((kind) => ({
		type: 'remove-surface' as const,
		surfaceId: singletonSurfaceId(kind),
	}));
}

export class WorkspacePresentationController {
	lastFocusedSurfaceId = $state(CHAT_SURFACE_ID as string);
	lastFocusedPaneId = $state<PaneId | null>(null);
	focusOwner = $state<FocusOwner>({ kind: 'surface', surfaceId: CHAT_SURFACE_ID });
	#inFlightCommitCount = 0;
	#presentationMode = $state<PresentationMode>('desktop');
	#requestedPresentationMode: PresentationMode = 'desktop';
	#responsiveGeneration = 0;
	readonly #mobilePresentation: MobilePresentationPlanner;
	readonly #frames: WorkspacePresentationFrames;

	constructor(private readonly deps: WorkspacePresentationControllerDeps) {
		this.#mobilePresentation = new MobilePresentationPlanner({
			getContext: () => deps.workspaceContext.current,
			getRouteIdentity: deps.getRouteIdentity,
		});
		this.#frames = new WorkspacePresentationFrames({
			frames: deps.surfaceFrames,
			terminals: deps.terminals,
			files: deps.files,
		});
		this.#presentationMode = deps.appShell.isMobile ? 'mobile' : 'desktop';
		this.#requestedPresentationMode = this.#presentationMode;
		deps.chatInteractionGate.setPresented(
			this.#isChatPresentedInSnapshot(this.layout.snapshot, this.#presentationMode),
		);
		this.#syncSingletonVisibility(this.layout.snapshot, this.#presentationMode);
	}

	get layout() {
		return this.deps.arbiter.layout;
	}

	get isMobile(): boolean {
		return this.#presentationMode === 'mobile';
	}

	get defaultActiveId(): string {
		return this.layout.defaultActiveId;
	}

	get isChatPresented(): boolean {
		return this.#isChatPresentedInSnapshot(this.layout.snapshot);
	}

	get isChatInteractive(): boolean {
		return this.isChatPresented && !this.deps.transientLayers.makesMainInert;
	}

	get responsiveGeneration(): number {
		return this.#responsiveGeneration;
	}

	get inFlightCommitCount(): number {
		return this.#inFlightCommitCount;
	}

	get attachmentErrors(): Readonly<Record<string, string>> {
		return this.#frames.errors;
	}

	frameVersion(surfaceId: string): number {
		return this.#frames.version(surfaceId);
	}

	isSurfacePresented(surfaceId: string): boolean {
		return [...this.#visiblePresentations(this.layout.snapshot).values()].includes(surfaceId);
	}

	paneOf(surfaceId: string): PaneId | null {
		return this.paneOfSnapshot(this.layout.snapshot, surfaceId);
	}

	paneOfSnapshot(snapshot: WorkspaceLayoutSnapshot, surfaceId: string): PaneId | null {
		return paneIdOfSurface(snapshot.desktopRoot, surfaceId);
	}

	eligibleDesktopReturn(surfaceId: string | null): string | null {
		if (!surfaceId || !this.layout.surface(surfaceId)) return null;
		const snapshot = this.layout.snapshot;
		const paneId = paneIdOfSurface(snapshot.desktopRoot, surfaceId);
		if (paneId && isDesktopPanePresented(snapshot, paneId)) return surfaceId;
		return null;
	}

	returnStackForTransient(
		surfaceId: string,
	): ReturnType<MobilePresentationPlanner['returnStackForTransient']> {
		return this.#mobilePresentation.returnStackForTransient(
			surfaceId,
			this.layout.snapshot,
			this.isMobile,
		);
	}

	resolveMobileReturn(
		excluding: string | ReadonlySet<string>,
		snapshot = this.layout.snapshot,
	): ReturnType<MobilePresentationPlanner['resolveReturn']> {
		return this.#mobilePresentation.resolveReturn(excluding, snapshot);
	}

	noteSurfaceFocus(surfaceId: string): void {
		if (!this.isSurfacePresented(surfaceId)) return;
		this.focusOwner = { kind: 'surface', surfaceId };
		this.lastFocusedSurfaceId = surfaceId;
		const paneId = this.paneOf(surfaceId);
		if (paneId) this.lastFocusedPaneId = paneId;
	}

	noteChatListFocus(): void {
		this.focusOwner = { kind: 'chat-list' };
	}

	notePaneChromeFocus(paneId: PaneId, surfaceId: string): void {
		if (!this.isSurfacePresented(surfaceId)) return;
		this.focusOwner = { kind: 'pane-chrome', paneId, surfaceId };
		this.lastFocusedPaneId = paneId;
	}

	async focusChat(): Promise<void> {
		this.deps.chatInteractionGate.cancelBeforeInertTransition();
		const current = this.isMobile
			? await this.commit([
					{ type: 'set-mobile-presentation', activeId: CHAT_SURFACE_ID, returnStack: [] },
				])
			: await this.commit((latest) => {
					const paneId = paneIdOfSurface(latest.desktopRoot, CHAT_SURFACE_ID);
					if (!paneId) return [];
					return [
						...(latest.fullscreenPaneId && latest.fullscreenPaneId !== paneId
							? [{ type: 'set-fullscreen-pane', paneId: null } as const]
							: []),
						{ type: 'activate-pane-tab', paneId, surfaceId: CHAT_SURFACE_ID },
					];
				});
		if (current) this.presentSurface(CHAT_SURFACE_ID);
	}

	async focusSurface(surfaceId: string, reserved: ReadonlySet<string>): Promise<void> {
		if (reserved.has(surfaceId)) return;
		const paneId = this.paneOf(surfaceId);
		if (!paneId) return;
		if (surfaceId !== CHAT_SURFACE_ID && this.isChatPresented) {
			this.deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		let current: boolean;
		if (this.isMobile) {
			current = await this.commit((latest) =>
				latest.surfaces[surfaceId]
					? [{ type: 'set-mobile-presentation', activeId: surfaceId, returnStack: [] }]
					: [],
			);
		} else {
			current = await this.commit((latest) => {
				const latestPaneId = paneIdOfSurface(latest.desktopRoot, surfaceId);
				if (!latestPaneId) return [];
				return [
					...(latest.fullscreenPaneId && latest.fullscreenPaneId !== latestPaneId
						? [{ type: 'set-fullscreen-pane', paneId: null } as const]
						: []),
					{ type: 'activate-pane-tab', paneId: latestPaneId, surfaceId },
				];
			});
		}
		if (current) this.presentSurface(surfaceId);
	}

	focusPreviousTab(owner: FocusOwner, focusSurface: (surfaceId: string) => void): boolean {
		return this.#focusAdjacentTab(owner, -1, focusSurface);
	}

	focusNextTab(owner: FocusOwner, focusSurface: (surfaceId: string) => void): boolean {
		return this.#focusAdjacentTab(owner, 1, focusSurface);
	}

	// Cycles focus to the next pane's active tab. Replaces the old
	// main/sidebar focus toggle now that panes are arbitrary.
	cyclePaneFocus(owner: FocusOwner, focusSurface: (surfaceId: string) => void): void {
		if (this.isMobile) return;
		const snapshot = this.layout.snapshot;
		if (snapshot.fullscreenPaneId !== null) return;
		const panes = collectPaneNodes(snapshot.desktopRoot);
		if (panes.length < 2) return;
		const ownerPaneId =
			owner.kind === 'pane-chrome'
				? owner.paneId
				: owner.kind === 'surface'
					? this.paneOf(owner.surfaceId)
					: null;
		const currentIndex = panes.findIndex((pane) => pane.id === ownerPaneId);
		const nextPane = panes[(currentIndex + 1 + panes.length) % panes.length];
		if (nextPane.tabs.activeId) focusSurface(nextPane.tabs.activeId);
	}

	async enterMobilePresentation(): Promise<void> {
		if (this.#requestedPresentationMode === 'mobile') return;
		this.#requestedPresentationMode = 'mobile';
		this.deps.chatInteractionGate.cancelBeforeInertTransition();
		const responsiveGeneration = ++this.#responsiveGeneration;
		const from = this.#presentationMode;
		let activeId = CHAT_SURFACE_ID as string;
		let current: boolean;
		try {
			current = await this.commit(
				(latest) => {
					activeId = selectMobileEntrySurface(latest, this.lastFocusedSurfaceId);
					return [
						{
							type: 'set-mobile-presentation',
							activeId,
							returnStack: latest.mobileReturnStack,
						},
					];
				},
				{ presentationMode: 'mobile' },
			);
		} catch (error) {
			if (
				responsiveGeneration === this.#responsiveGeneration &&
				this.#presentationMode !== 'mobile'
			) {
				this.#requestedPresentationMode = from;
				this.#setPresentationMode(from);
			}
			throw error;
		}
		if (!current || responsiveGeneration !== this.#responsiveGeneration) return;
		this.presentSurface(activeId);
	}

	async exitMobilePresentation(): Promise<void> {
		if (this.#requestedPresentationMode === 'desktop') return;
		this.#requestedPresentationMode = 'desktop';
		this.deps.chatInteractionGate.cancelBeforeInertTransition();
		const responsiveGeneration = ++this.#responsiveGeneration;
		let plannedTransientKinds: TransientMobileSingletonKind[] = [];
		let current: boolean;
		try {
			current = await this.commit(
				(latest) => {
					plannedTransientKinds = transientMobileGitViewKinds(latest);
					return this.#mobilePresentation.planDesktopReturn(latest);
				},
				{ presentationMode: 'desktop' },
			);
		} catch (error) {
			if (
				responsiveGeneration === this.#responsiveGeneration &&
				this.#presentationMode !== 'desktop'
			) {
				this.#requestedPresentationMode = 'mobile';
				this.#setPresentationMode('mobile');
			} else if (
				responsiveGeneration === this.#responsiveGeneration &&
				this.#presentationMode === 'desktop'
			) {
				await this.#reconcileTransientMobileGitViews(plannedTransientKinds, responsiveGeneration);
			}
			throw error;
		}
		await this.#reconcileTransientMobileGitViews(plannedTransientKinds, responsiveGeneration);
		if (!current || responsiveGeneration !== this.#responsiveGeneration) return;
		this.focusPresentedSurface(this.lastFocusedSurfaceId);
	}

	async focusMobileSingleton(kind: PortableSingletonKind): Promise<void> {
		this.deps.chatInteractionGate.cancelBeforeInertTransition();
		const surfaceId = singletonSurfaceId(kind);
		if (!this.layout.surface(surfaceId)) {
			await this.commit([{ type: 'register-surface', surface: portableSingletonDescriptor(kind) }]);
		}
		const current = await this.commit([
			{
				type: 'set-mobile-presentation',
				activeId: surfaceId,
				returnStack:
					kind === 'commit' || isTransientMobileSingletonKind(kind)
						? this.#mobilePresentation.returnStackForTransient(
								surfaceId,
								this.layout.snapshot,
								this.isMobile,
							)
						: this.layout.snapshot.mobileReturnStack,
			},
		]);
		if (current) this.presentSurface(surfaceId);
	}

	async mobileBack(): Promise<void> {
		if (!this.isMobile) return;
		const fallback = this.#mobilePresentation.resolveReturn(
			this.layout.snapshot.mobileActiveSurfaceId,
			this.layout.snapshot,
		);
		const current = await this.commit([
			{
				type: 'set-mobile-presentation',
				activeId: fallback.activeId,
				returnStack: fallback.returnStack,
			},
		]);
		if (current) this.presentSurface(fallback.activeId);
	}

	async retryPresentation(surfaceId: string, host: PresentationHostId): Promise<void> {
		if (!this.layout.surface(surfaceId)) return;
		const current = await this.#frames.retry(surfaceId, host);
		if (current) this.focusPresentedSurface(surfaceId);
	}

	presentSurface(surfaceId: string): void {
		this.lastFocusedSurfaceId = surfaceId;
		const paneId = this.paneOf(surfaceId);
		if (paneId) this.lastFocusedPaneId = paneId;
		if (this.isMobile) this.#mobilePresentation.noteActivation(surfaceId);
		this.focusPresentedSurface(surfaceId);
	}

	focusPresentedSurface(surfaceId: string): void {
		if (surfaceId === CHAT_SURFACE_ID) {
			this.deps.appShell.requestComposerFocus();
			return;
		}
		const host = this.#presentationHostOf(surfaceId);
		if (host) this.deps.surfaceFrames?.focus(surfaceId, host);
	}

	clearAttachmentError(surfaceId: string): void {
		this.#frames.clearError(surfaceId);
	}

	async commitDestroyedRemovals(
		surfaceIds: readonly string[],
		mutations: WorkspaceMutationPlan,
	): Promise<boolean> {
		try {
			return await this.commit(mutations, { requiredPublication: true });
		} catch (error) {
			const remaining = surfaceIds.filter((surfaceId) => this.layout.surface(surfaceId));
			if (remaining.length === 0) {
				console.error('Required workspace removal completed with degraded follow-up work', error);
				return true;
			}
			console.error('Retrying required workspace removal after a publication failure', error);
			const removed = await this.deps.arbiter.commit(
				(latest) =>
					remaining.flatMap((surfaceId) =>
						latest.surfaces[surfaceId] ? [{ type: 'remove-surface' as const, surfaceId }] : [],
					),
				{},
				{ retryPublishFailure: true },
			);
			const survivors = remaining.filter((surfaceId) => this.layout.surface(surfaceId));
			if (!removed || survivors.length > 0) {
				throw new Error(`Required workspace removal failed for ${survivors.join(', ')}`, {
					cause: error,
				});
			}
			return true;
		}
	}

	async #reconcileTransientMobileGitViews(
		plannedKinds: readonly TransientMobileSingletonKind[],
		responsiveGeneration: number,
	): Promise<void> {
		this.#disposeAbsentTransientMobileGitViews(plannedKinds);
		if (
			responsiveGeneration !== this.#responsiveGeneration ||
			this.#presentationMode !== 'desktop'
		) {
			return;
		}
		let reconciledKinds: TransientMobileSingletonKind[] = [];
		await this.commitDestroyedRemovals(
			(['git-history', 'git-compare'] as const).map((kind) => singletonSurfaceId(kind)),
			(latest) => {
				reconciledKinds = transientMobileGitViewKinds(latest);
				return removeTransientMobileGitViews(latest);
			},
		);
		this.#disposeAbsentTransientMobileGitViews([...plannedKinds, ...reconciledKinds]);
	}

	#disposeAbsentTransientMobileGitViews(kinds: readonly TransientMobileSingletonKind[]): void {
		for (const kind of new Set(kinds)) {
			if (!this.layout.surface(singletonSurfaceId(kind))) {
				this.deps.singletons.disposeSurface(kind);
			}
		}
	}

	async commit(
		mutations: WorkspaceMutationPlan,
		options: WorkspaceCommitOptions = {},
	): Promise<boolean> {
		this.#inFlightCommitCount += 1;
		try {
			return await this.#performCommit(mutations, options);
		} finally {
			this.#inFlightCommitCount -= 1;
		}
	}

	#focusAdjacentTab(
		owner: FocusOwner,
		offset: -1 | 1,
		focusSurface: (surfaceId: string) => void,
	): boolean {
		if (this.isMobile || owner.kind === 'chat-list') return false;
		if (!this.isSurfacePresented(owner.surfaceId)) return false;
		const snapshot = this.layout.snapshot;
		const paneId =
			owner.kind === 'pane-chrome' ? owner.paneId : this.paneOfSnapshot(snapshot, owner.surfaceId);
		if (!paneId || !isDesktopPanePresented(snapshot, paneId)) {
			return false;
		}
		const pane = paneNodeById(snapshot.desktopRoot, paneId);
		if (!pane || pane.tabs.activeId !== owner.surfaceId) return false;
		const activeIndex = pane.tabs.activeId ? pane.tabs.order.indexOf(pane.tabs.activeId) : -1;
		if (activeIndex < 0) return false;
		const nextSurfaceId = pane.tabs.order[activeIndex + offset];
		if (nextSurfaceId) focusSurface(nextSurfaceId);
		return true;
	}

	#presentationHostOf(surfaceId: string): PresentationHostId | null {
		const snapshot = this.layout.snapshot;
		if (this.#presentationMode === 'mobile') {
			return snapshot.mobileActiveSurfaceId === surfaceId ? 'mobile' : null;
		}
		if (snapshot.dialogFileSurfaceId === surfaceId) return 'dialog';
		const paneId = paneIdOfSurface(snapshot.desktopRoot, surfaceId);
		if (
			paneId &&
			isDesktopPanePresented(snapshot, paneId) &&
			paneNodeById(snapshot.desktopRoot, paneId)?.tabs.activeId === surfaceId
		) {
			return paneId;
		}
		return null;
	}

	#setPresentationMode(mode: PresentationMode): void {
		this.#presentationMode = mode;
		this.deps.appShell.isMobile = mode === 'mobile';
	}

	async #performCommit(
		mutations: WorkspaceMutationPlan,
		options: WorkspaceCommitOptions,
	): Promise<boolean> {
		let expectations: ReturnType<WorkspacePresentationFrames['prepare']> = [];
		let presentationGeneration: number | null = null;
		let presentationFrom: PresentationMode | null = null;
		let presentationTo: PresentationMode | null = null;
		const published = await this.deps.arbiter.commit(
			mutations,
			{
				beforePublish: (next, base) => {
					presentationTo = options.presentationMode ?? this.#presentationMode;
					try {
						if (options.presentationMode) {
							presentationFrom = this.#presentationMode;
							this.#setPresentationMode(options.presentationMode);
						}
						this.deps.chatInteractionGate.setPresented(
							this.#isChatPresentedInSnapshot(next, presentationTo),
						);
						this.#hideLeavingSingletons(
							base,
							next,
							presentationFrom ?? this.#presentationMode,
							presentationTo,
						);
						options.publication?.publish();
						presentationGeneration = this.#frames.beginTransition(
							base,
							next,
							presentationFrom ?? this.#presentationMode,
							presentationTo,
						);
						expectations = this.#frames.prepare(
							base,
							next,
							presentationFrom ?? this.#presentationMode,
							presentationTo,
						);
					} catch (error) {
						if (!options.requiredPublication) throw error;
						expectations = [];
						this.#frames.recordPreparationError(next, error, presentationTo);
					}
				},
				publishFailed: () => {
					try {
						if (presentationFrom) this.#setPresentationMode(presentationFrom);
						this.deps.chatInteractionGate.setPresented(
							this.#isChatPresentedInSnapshot(this.layout.snapshot, presentationFrom ?? undefined),
						);
						this.#syncSingletonVisibility(this.layout.snapshot, presentationFrom ?? undefined);
						options.publication?.rollback();
						this.#frames.cancel(expectations);
					} catch (error) {
						if (!options.requiredPublication) throw error;
						console.error('Failed to roll back required workspace publication', error);
					}
				},
			},
			{ retryPublishFailure: false },
		);
		if (!published) throw new WorkspacePublicationInvariantError();
		if (!presentationTo) {
			throw new WorkspacePublicationInvariantError('Workspace presentation mode was not prepared');
		}
		this.#syncSingletonVisibility(this.layout.snapshot, presentationTo);
		this.#normalizeFocusOwner(this.layout.snapshot, presentationTo);
		try {
			this.deps.onLayoutChanged?.(this.layout.snapshot);
		} catch (error) {
			if (!options.requiredPublication) throw error;
			console.error('Failed to persist required workspace layout publication', error);
		}
		await Promise.all(expectations.map((expectation) => this.#frames.settle(expectation)));
		return this.#frames.isTransitionCurrent(presentationGeneration);
	}

	#normalizeFocusOwner(
		snapshot: WorkspaceLayoutSnapshot,
		mode: PresentationMode = this.#presentationMode,
	): void {
		if (!this.lastFocusedPaneId || !paneNodeById(snapshot.desktopRoot, this.lastFocusedPaneId)) {
			this.lastFocusedPaneId =
				paneIdOfSurface(snapshot.desktopRoot, this.lastFocusedSurfaceId) ??
				paneIdOfSurface(snapshot.desktopRoot, CHAT_SURFACE_ID) ??
				collectPaneNodes(snapshot.desktopRoot)[0]?.id ??
				null;
		}
		if (this.focusOwner.kind === 'chat-list') return;
		const visible = new Set(this.#visiblePresentations(snapshot, mode).values());
		if (visible.has(this.focusOwner.surfaceId)) return;
		const fallback =
			(visible.has(this.lastFocusedSurfaceId) ? this.lastFocusedSurfaceId : null) ??
			visible.values().next().value ??
			CHAT_SURFACE_ID;
		this.focusOwner = { kind: 'surface', surfaceId: fallback };
		this.lastFocusedSurfaceId = fallback;
	}

	#isChatPresentedInSnapshot(
		snapshot: WorkspaceLayoutSnapshot,
		mode: PresentationMode = this.#presentationMode,
	): boolean {
		if (mode === 'mobile') {
			return visiblePresentationMap(snapshot, mode).get('mobile') === CHAT_SURFACE_ID;
		}
		const chatPaneId = paneIdOfSurface(snapshot.desktopRoot, CHAT_SURFACE_ID);
		if (!chatPaneId || !isDesktopPanePresented(snapshot, chatPaneId)) return false;
		return paneNodeById(snapshot.desktopRoot, chatPaneId)?.tabs.activeId === CHAT_SURFACE_ID;
	}

	#syncSingletonVisibility(
		snapshot: WorkspaceLayoutSnapshot,
		mode: PresentationMode = this.#presentationMode,
	): void {
		const visibleSurfaceIds = new Set(this.#visiblePresentations(snapshot, mode).values());
		for (const kind of PORTABLE_SINGLETON_KINDS) {
			this.deps.singletons.setPresentationVisible(
				kind,
				visibleSurfaceIds.has(singletonSurfaceId(kind)),
			);
		}
	}

	#hideLeavingSingletons(
		base: WorkspaceLayoutSnapshot,
		next: WorkspaceLayoutSnapshot,
		fromMode: PresentationMode = this.#presentationMode,
		toMode: PresentationMode = this.#presentationMode,
	): void {
		const before = new Set(this.#visiblePresentations(base, fromMode).values());
		const after = new Set(this.#visiblePresentations(next, toMode).values());
		for (const kind of PORTABLE_SINGLETON_KINDS) {
			const surfaceId = singletonSurfaceId(kind);
			if (before.has(surfaceId) && !after.has(surfaceId)) {
				this.deps.singletons.setPresentationVisible(kind, false);
			}
		}
	}

	#visiblePresentations(
		snapshot: WorkspaceLayoutSnapshot,
		mode: PresentationMode = this.#presentationMode,
	): Map<PresentationHostId, string> {
		return visiblePresentationMap(snapshot, mode);
	}
}
