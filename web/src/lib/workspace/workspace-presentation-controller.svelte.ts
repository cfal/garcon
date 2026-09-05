import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import { tick } from 'svelte';
import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import type { SingletonSurfaceRegistry } from './singleton-surfaces.svelte.js';
import type { SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import type { WorkspaceInteractionGate } from './workspace-interaction-gate.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import type { WorkspaceCommitOptions } from './workspace-commit.js';
import { MobilePresentationPlanner } from './mobile-presentation-planner.js';
import { selectMobileEntrySurface } from './responsive-handoff.js';
import {
	PORTABLE_SINGLETON_KINDS,
	isTransientMobileSingletonKind,
	portableSingletonDescriptor,
	singletonSurfaceId,
	type ChatViewSurfaceId,
	type FocusOwner,
	type PortableSingletonKind,
	type PresentationHostId,
	type TransientMobileSingletonKind,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowId,
} from './surface-types.js';
import { collectWindowNodes, windowIdOfSurface, windowNodeById } from './window-tree.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';
import { WorkspaceTransitionArbiter } from './workspace-transition-arbiter.js';
import { isDesktopWindowPresented, visiblePresentationMap } from './visible-presentations.js';
import { WorkspacePresentationFrames } from './workspace-presentation-frames.svelte.js';

type PresentationMode = 'desktop' | 'mobile';

interface WorkspacePresentationControllerDeps {
	arbiter: WorkspaceTransitionArbiter;
	terminals: TerminalRegistry;
	workspaceContext: WorkspaceContextStore;
	appShell: AppShellStore;
	workspaceInteractionGate: WorkspaceInteractionGate;
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
		return surface?.type === 'singleton' && isTransientMobileSingletonKind(surface.kind)
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
	lastFocusedSurfaceId = $state('');
	lastFocusedWindowId = $state<WorkspaceWindowId | null>(null);
	focusOwner = $state<FocusOwner>({ kind: 'chat-list' });
	composerAnchorSurfaceId = $state<ChatViewSurfaceId | null>(null);
	#inFlightCommitCount = 0;
	#presentationMode = $state<PresentationMode>('desktop');
	#requestedPresentationMode: PresentationMode = 'desktop';
	#responsiveGeneration = 0;
	#focusIntentGeneration = 0;
	#pointerInteraction: {
		readonly windowId: WorkspaceWindowId;
		readonly pointerId: number;
	} | null = null;
	#pointerInteractionRelease: ReturnType<typeof setTimeout> | null = null;
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
		this.lastFocusedSurfaceId = this.layout.defaultActiveId;
		this.lastFocusedWindowId = this.layout.defaultWindowId;
		this.focusOwner = { kind: 'surface', surfaceId: this.lastFocusedSurfaceId };
		this.#adoptComposerAnchor(this.lastFocusedSurfaceId);
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

	get defaultWindowId(): WorkspaceWindowId {
		return this.layout.defaultWindowId;
	}

	get currentWindowId(): WorkspaceWindowId {
		return this.resolveCurrentWindow(this.layout.snapshot);
	}

	get currentChatSurfaceId(): string | null {
		return this.#chatSurfaceInWindow(this.layout.snapshot, this.currentWindowId);
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

	windowOf(surfaceId: string): WorkspaceWindowId | null {
		return this.windowOfSnapshot(this.layout.snapshot, surfaceId);
	}

	windowOfSnapshot(snapshot: WorkspaceLayoutSnapshot, surfaceId: string): WorkspaceWindowId | null {
		return windowIdOfSurface(snapshot.desktopRoot, surfaceId);
	}

	resolveCurrentWindow(snapshot: WorkspaceLayoutSnapshot): WorkspaceWindowId {
		if (
			this.lastFocusedWindowId &&
			windowNodeById(snapshot.desktopRoot, this.lastFocusedWindowId)
		) {
			return this.lastFocusedWindowId;
		}
		const surfaceWindow = windowIdOfSurface(snapshot.desktopRoot, this.lastFocusedSurfaceId);
		if (surfaceWindow) return surfaceWindow;
		const first = collectWindowNodes(snapshot.desktopRoot)[0];
		if (!first) throw new Error('Workspace has no windows');
		return first.id;
	}

	eligibleDesktopReturn(surfaceId: string | null): string | null {
		if (!surfaceId || !this.layout.surface(surfaceId)) return null;
		const windowId = windowIdOfSurface(this.layout.snapshot.desktopRoot, surfaceId);
		return windowId && isDesktopWindowPresented(this.layout.snapshot, windowId) ? surfaceId : null;
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
		sourceSnapshot = snapshot,
	): ReturnType<MobilePresentationPlanner['resolveReturn']> {
		return this.#mobilePresentation.resolveReturn(excluding, snapshot, sourceSnapshot);
	}

	noteSurfaceFocus(surfaceId: string): void {
		if (!this.isSurfacePresented(surfaceId)) return;
		const windowId = this.windowOf(surfaceId);
		this.#supersedeFocusIntent();
		this.focusOwner = { kind: 'surface', surfaceId };
		this.lastFocusedSurfaceId = surfaceId;
		if (windowId) this.lastFocusedWindowId = windowId;
		if (!this.#pointerInteraction) this.#adoptComposerAnchor(surfaceId);
	}

	noteChatListFocus(): void {
		this.#supersedeFocusIntent();
		this.focusOwner = { kind: 'chat-list' };
	}

	noteWindowChromeFocus(windowId: WorkspaceWindowId, surfaceId: string): void {
		if (!windowNodeById(this.layout.snapshot.desktopRoot, windowId)) return;
		this.#supersedeFocusIntent();
		this.focusOwner = { kind: 'window-chrome', windowId, surfaceId };
		this.lastFocusedWindowId = windowId;
		this.lastFocusedSurfaceId = surfaceId;
		if (!this.#pointerInteraction) this.#adoptComposerAnchor(surfaceId);
	}

	beginWindowPointerInteraction(windowId: WorkspaceWindowId, pointerId: number): void {
		if (this.isMobile) return;
		const snapshot = this.layout.snapshot;
		const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
		if (!workspaceWindow || !isDesktopWindowPresented(snapshot, windowId)) return;
		this.#clearPointerInteractionRelease();
		this.#supersedeFocusIntent();
		const surfaceId = workspaceWindow.tabs.activeId;
		this.focusOwner = { kind: 'surface', surfaceId };
		this.lastFocusedWindowId = windowId;
		this.lastFocusedSurfaceId = surfaceId;
		this.#pointerInteraction = { windowId, pointerId };
	}

	commitWindowPointerInteraction(windowId: WorkspaceWindowId): void {
		if (this.isMobile) return;
		const snapshot = this.layout.snapshot;
		const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
		if (!workspaceWindow || !isDesktopWindowPresented(snapshot, windowId)) {
			this.#clearPointerInteraction();
			return;
		}
		this.#supersedeFocusIntent();
		const surfaceId = workspaceWindow.tabs.activeId;
		this.focusOwner = { kind: 'surface', surfaceId };
		this.lastFocusedWindowId = windowId;
		this.lastFocusedSurfaceId = surfaceId;
		this.#adoptComposerAnchor(surfaceId);
		this.#clearPointerInteraction();
	}

	releaseWindowPointerInteraction(windowId: WorkspaceWindowId, pointerId: number): void {
		const pending = this.#pointerInteraction;
		if (!pending || pending.windowId !== windowId || pending.pointerId !== pointerId) return;
		this.#clearPointerInteractionRelease();
		this.#pointerInteractionRelease = setTimeout(() => {
			this.#pointerInteractionRelease = null;
			if (this.#pointerInteraction === pending) this.#pointerInteraction = null;
		}, 0);
	}

	cancelWindowPointerInteraction(windowId: WorkspaceWindowId, pointerId: number): void {
		const pending = this.#pointerInteraction;
		if (!pending || pending.windowId !== windowId || pending.pointerId !== pointerId) return;
		this.#clearPointerInteraction();
	}

	cancelPendingWindowPointerInteraction(): void {
		this.#clearPointerInteraction();
	}

	activateWindow(windowId: WorkspaceWindowId): void {
		if (this.isMobile) return;
		const snapshot = this.layout.snapshot;
		const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
		if (!workspaceWindow || !isDesktopWindowPresented(snapshot, windowId)) return;

		this.deps.workspaceInteractionGate.cancelBeforeInertTransition();
		const generation = this.#supersedeFocusIntent();
		const surfaceId = workspaceWindow.tabs.activeId;
		this.focusOwner = { kind: 'surface', surfaceId };
		this.lastFocusedWindowId = windowId;
		this.lastFocusedSurfaceId = surfaceId;
		if (!this.#pointerInteraction) this.#adoptComposerAnchor(surfaceId);

		void tick().then(() => {
			if (generation !== this.#focusIntentGeneration || this.currentWindowId !== windowId) return;
			const currentWindow = windowNodeById(this.layout.snapshot.desktopRoot, windowId);
			if (currentWindow?.tabs.activeId !== surfaceId) return;
			this.focusPresentedSurface(surfaceId);
		});
	}

	async focusChat(): Promise<void> {
		this.deps.workspaceInteractionGate.cancelBeforeInertTransition();
		this.#supersedeFocusIntent();
		let surfaceId: string | null = null;
		const current = await this.commit((latest) => {
			const preferredWindowId = this.resolveCurrentWindow(latest);
			surfaceId =
				this.#chatSurfaceInWindow(latest, preferredWindowId) ??
				collectWindowNodes(latest.desktopRoot)
					.map((workspaceWindow) => this.#chatSurfaceInWindow(latest, workspaceWindow.id))
					.find((candidate): candidate is string => Boolean(candidate)) ??
				null;
			if (!surfaceId) return [];
			if (this.isMobile) {
				return [{ type: 'set-mobile-presentation', activeId: surfaceId, returnStack: [] }];
			}
			const windowId = windowIdOfSurface(latest.desktopRoot, surfaceId);
			return windowId ? [{ type: 'activate-window-tab', windowId, surfaceId }] : [];
		});
		if (current && surfaceId) this.presentSurface(surfaceId);
	}

	async focusSurface(surfaceId: string, reserved: ReadonlySet<string>): Promise<void> {
		if (reserved.has(surfaceId)) return;
		const windowId = this.windowOf(surfaceId);
		if (!windowId && !this.isMobile) return;
		this.deps.workspaceInteractionGate.cancelBeforeInertTransition();
		this.#supersedeFocusIntent();
		const current = this.isMobile
			? await this.commit((latest) =>
					latest.surfaces[surfaceId]
						? [{ type: 'set-mobile-presentation', activeId: surfaceId, returnStack: [] }]
						: [],
				)
			: await this.commit((latest) => {
					const latestWindowId = windowIdOfSurface(latest.desktopRoot, surfaceId);
					return latestWindowId
						? [{ type: 'activate-window-tab', windowId: latestWindowId, surfaceId }]
						: [];
				});
		if (current) this.presentSurface(surfaceId);
	}

	focusPreviousTab(owner: FocusOwner, focusSurface: (surfaceId: string) => void): boolean {
		return this.#focusAdjacentTab(owner, -1, focusSurface);
	}

	focusNextTab(owner: FocusOwner, focusSurface: (surfaceId: string) => void): boolean {
		return this.#focusAdjacentTab(owner, 1, focusSurface);
	}

	cycleWindowFocus(
		owner: FocusOwner,
		activateWindow: (windowId: WorkspaceWindowId) => boolean,
	): void {
		if (this.isMobile || this.layout.snapshot.fullscreenWindowId) return;
		const windows = collectWindowNodes(this.layout.snapshot.desktopRoot);
		if (windows.length < 2) return;
		let ownerWindowId: WorkspaceWindowId | null = null;
		if (owner.kind === 'window-chrome') {
			ownerWindowId = owner.windowId;
		} else if (owner.kind === 'surface') {
			ownerWindowId = this.windowOf(owner.surfaceId);
		}
		const currentIndex = windows.findIndex(
			(workspaceWindow) => workspaceWindow.id === ownerWindowId,
		);
		const candidates =
			currentIndex < 0
				? windows
				: [...windows.slice(currentIndex + 1), ...windows.slice(0, currentIndex)];
		for (const candidate of candidates) {
			if (activateWindow(candidate.id)) return;
		}
	}

	async enterMobilePresentation(): Promise<void> {
		if (this.#requestedPresentationMode === 'mobile') return;
		this.#requestedPresentationMode = 'mobile';
		this.deps.workspaceInteractionGate.cancelBeforeInertTransition();
		const responsiveGeneration = ++this.#responsiveGeneration;
		const from = this.#presentationMode;
		let activeId = this.layout.defaultActiveId;
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
		this.deps.workspaceInteractionGate.cancelBeforeInertTransition();
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
		this.deps.workspaceInteractionGate.cancelBeforeInertTransition();
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
		this.#focusIntentGeneration += 1;
		this.lastFocusedSurfaceId = surfaceId;
		const windowId = this.windowOf(surfaceId);
		if (windowId) this.lastFocusedWindowId = windowId;
		if (this.isMobile) this.#mobilePresentation.noteActivation(surfaceId);
		this.#adoptComposerAnchor(surfaceId);
		this.focusPresentedSurface(surfaceId);
	}

	focusPresentedSurface(surfaceId: string): void {
		if (this.layout.surface(surfaceId)?.type === 'chat') {
			this.deps.appShell.requestComposerFocus();
			return;
		}
		const host = this.#presentationHostOf(surfaceId);
		if (host) this.deps.surfaceFrames?.focus(surfaceId, host);
	}

	#supersedeFocusIntent(): number {
		this.#frames.supersedePendingTransition();
		this.#focusIntentGeneration += 1;
		return this.#focusIntentGeneration;
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
			if (surfaceIds.length > 0 && remaining.length === 0) {
				console.error('Required workspace removal completed with degraded follow-up work', error);
				return true;
			}
			console.error('Retrying required workspace removal after a publication failure', error);
			const removed = await this.deps.arbiter.commit(mutations, {}, { retryPublishFailure: true });
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
			if (!this.layout.surface(singletonSurfaceId(kind))) this.deps.singletons.disposeSurface(kind);
		}
	}

	async commit(
		mutations: WorkspaceMutationPlan,
		options: WorkspaceCommitOptions = {},
	): Promise<boolean> {
		return this.#commit(mutations, options);
	}

	async commitWithPresentationTarget(
		mutations: WorkspaceMutationPlan,
		resolveTarget: () => string | null,
		options: WorkspaceCommitOptions = {},
	): Promise<boolean> {
		return this.#commit(mutations, options, resolveTarget);
	}

	async #commit(
		mutations: WorkspaceMutationPlan,
		options: WorkspaceCommitOptions,
		resolveTarget?: () => string | null,
	): Promise<boolean> {
		this.#inFlightCommitCount += 1;
		try {
			return await this.#performCommit(mutations, options, resolveTarget);
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
		const windowId =
			owner.kind === 'window-chrome'
				? owner.windowId
				: this.windowOfSnapshot(snapshot, owner.surfaceId);
		if (!windowId || !isDesktopWindowPresented(snapshot, windowId)) return false;
		const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
		if (!workspaceWindow || workspaceWindow.tabs.activeId !== owner.surfaceId) return false;
		const activeIndex = workspaceWindow.tabs.order.indexOf(workspaceWindow.tabs.activeId);
		const nextSurfaceId = workspaceWindow.tabs.order[activeIndex + offset];
		if (nextSurfaceId) focusSurface(nextSurfaceId);
		return true;
	}

	#presentationHostOf(surfaceId: string): PresentationHostId | null {
		const snapshot = this.layout.snapshot;
		if (this.#presentationMode === 'mobile') {
			return snapshot.mobileActiveSurfaceId === surfaceId ? 'mobile' : null;
		}
		if (snapshot.dialogFileSurfaceId === surfaceId) return 'dialog';
		const windowId = windowIdOfSurface(snapshot.desktopRoot, surfaceId);
		if (windowId && windowNodeById(snapshot.desktopRoot, windowId)?.tabs.activeId === surfaceId) {
			return windowId;
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
		resolveTarget?: () => string | null,
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
		const presentationTarget = resolveTarget?.() ?? null;
		if (presentationTarget) {
			this.#adoptPublishedPresentationTarget(
				this.layout.snapshot,
				presentationTarget,
				presentationTo,
			);
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

	#adoptPublishedPresentationTarget(
		snapshot: WorkspaceLayoutSnapshot,
		surfaceId: string,
		mode: PresentationMode,
	): void {
		if (![...this.#visiblePresentations(snapshot, mode).values()].includes(surfaceId)) return;
		this.focusOwner = { kind: 'surface', surfaceId };
		this.lastFocusedSurfaceId = surfaceId;
		const windowId = windowIdOfSurface(snapshot.desktopRoot, surfaceId);
		if (windowId) this.lastFocusedWindowId = windowId;
		this.#adoptComposerAnchor(surfaceId, snapshot);
	}

	#normalizeFocusOwner(
		snapshot: WorkspaceLayoutSnapshot,
		mode: PresentationMode = this.#presentationMode,
	): void {
		if (
			!this.lastFocusedWindowId ||
			!windowNodeById(snapshot.desktopRoot, this.lastFocusedWindowId)
		) {
			this.lastFocusedWindowId =
				windowIdOfSurface(snapshot.desktopRoot, this.lastFocusedSurfaceId) ??
				collectWindowNodes(snapshot.desktopRoot)[0]?.id ??
				null;
		}
		this.#normalizeComposerAnchor(snapshot);
		if (this.focusOwner.kind === 'chat-list') return;
		const visible = new Set(this.#visiblePresentations(snapshot, mode).values());
		if (visible.has(this.focusOwner.surfaceId)) return;
		const fallback =
			(visible.has(this.lastFocusedSurfaceId) ? this.lastFocusedSurfaceId : null) ??
			visible.values().next().value ??
			this.layout.defaultActiveId;
		this.focusOwner = { kind: 'surface', surfaceId: fallback };
		this.lastFocusedSurfaceId = fallback;
	}

	#adoptComposerAnchor(
		surfaceId: string,
		snapshot: WorkspaceLayoutSnapshot = this.layout.snapshot,
	): void {
		const surface = snapshot.surfaces[surfaceId];
		if (surface?.type === 'chat') this.composerAnchorSurfaceId = surface.id;
	}

	#normalizeComposerAnchor(snapshot: WorkspaceLayoutSnapshot): void {
		const anchor = this.composerAnchorSurfaceId;
		if (!anchor) return;
		if (snapshot.surfaces[anchor]?.type !== 'chat') this.composerAnchorSurfaceId = null;
	}

	#clearPointerInteraction(): void {
		this.#clearPointerInteractionRelease();
		this.#pointerInteraction = null;
	}

	#clearPointerInteractionRelease(): void {
		if (this.#pointerInteractionRelease === null) return;
		clearTimeout(this.#pointerInteractionRelease);
		this.#pointerInteractionRelease = null;
	}

	#chatSurfaceInWindow(
		snapshot: WorkspaceLayoutSnapshot,
		windowId: WorkspaceWindowId,
	): string | null {
		const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
		return (
			workspaceWindow?.tabs.order.find(
				(surfaceId) => snapshot.surfaces[surfaceId]?.type === 'chat',
			) ?? null
		);
	}

	#isChatPresentedInSnapshot(
		snapshot: WorkspaceLayoutSnapshot,
		mode: PresentationMode = this.#presentationMode,
	): boolean {
		return [...visiblePresentationMap(snapshot, mode).values()].some(
			(surfaceId) => snapshot.surfaces[surfaceId]?.type === 'chat',
		);
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
