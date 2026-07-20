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
	portableSingletonDescriptor,
	singletonSurfaceId,
	type FocusOwner,
	type HostId,
	type PortableSingletonKind,
	type PresentationHostId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';
import { WorkspaceTransitionArbiter } from './workspace-transition-arbiter.js';
import { visiblePresentationMap } from './visible-presentations.js';
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

function isSidebarHidden(snapshot: WorkspaceLayoutSnapshot): boolean {
	return !snapshot.sidebarOpen || snapshot.manualFullscreen;
}

function revealSidebarMutations(snapshot: WorkspaceLayoutSnapshot): WorkspaceLayoutMutation[] {
	const mutations: WorkspaceLayoutMutation[] = [];
	if (snapshot.manualFullscreen) {
		mutations.push({ type: 'set-manual-fullscreen', enabled: false });
	}
	if (!snapshot.sidebarOpen) mutations.push({ type: 'set-sidebar-open', open: true });
	return mutations;
}

export class WorkspacePresentationController {
	lastFocusedSurfaceId = $state(CHAT_SURFACE_ID as string);
	focusOwner = $state<FocusOwner>({ kind: 'surface', surfaceId: CHAT_SURFACE_ID });
	#sidebarOverlayMode = false;
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

	get activeMainId(): string {
		return this.layout.snapshot.main.activeId ?? CHAT_SURFACE_ID;
	}

	get activeSidebarId(): string | null {
		return this.layout.snapshot.sidebar.activeId;
	}

	get isChatPresented(): boolean {
		return this.isMobile
			? this.layout.snapshot.mobileActiveSurfaceId === CHAT_SURFACE_ID
			: this.activeMainId === CHAT_SURFACE_ID;
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

	hostOf(surfaceId: string): HostId | null {
		return this.hostOfSnapshot(this.layout.snapshot, surfaceId);
	}

	hostOfSnapshot(snapshot: WorkspaceLayoutSnapshot, surfaceId: string): HostId | null {
		if (snapshot.main.order.includes(surfaceId)) return 'main';
		if (snapshot.sidebar.order.includes(surfaceId)) return 'sidebar';
		return null;
	}

	eligibleDesktopReturn(surfaceId: string | null): string | null {
		if (!surfaceId || !this.layout.surface(surfaceId)) return null;
		const snapshot = this.layout.snapshot;
		if (snapshot.main.order.includes(surfaceId)) return surfaceId;
		if (snapshot.sidebarOpen && snapshot.sidebar.order.includes(surfaceId)) return surfaceId;
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

	setSidebarOverlayMode(overlay: boolean): void {
		this.#sidebarOverlayMode = overlay;
	}

	noteSurfaceFocus(surfaceId: string): void {
		if (!this.isSurfacePresented(surfaceId)) return;
		this.focusOwner = { kind: 'surface', surfaceId };
		this.lastFocusedSurfaceId = surfaceId;
	}

	noteChatListFocus(): void {
		this.focusOwner = { kind: 'chat-list' };
	}

	noteHostChromeFocus(host: HostId, surfaceId: string): void {
		if (!this.isSurfacePresented(surfaceId)) return;
		this.focusOwner = { kind: 'host-chrome', host, surfaceId };
	}

	async focusChat(): Promise<void> {
		this.deps.chatInteractionGate.cancelBeforeInertTransition();
		const current = this.isMobile
			? await this.commit([
					{ type: 'set-mobile-presentation', activeId: CHAT_SURFACE_ID, returnStack: [] },
				])
			: await this.commit([{ type: 'focus-host', host: 'main', surfaceId: CHAT_SURFACE_ID }]);
		if (current) this.presentSurface(CHAT_SURFACE_ID);
	}

	async focusSurface(surfaceId: string, reserved: ReadonlySet<string>): Promise<void> {
		if (reserved.has(surfaceId)) return;
		const host = this.hostOf(surfaceId);
		if (!host) return;
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
			const plan = (latest: WorkspaceLayoutSnapshot) => {
				const latestHost = this.hostOfSnapshot(latest, surfaceId);
				if (!latestHost) return [];
				const mutations = latestHost === 'sidebar' ? revealSidebarMutations(latest) : [];
				mutations.push({ type: 'focus-host', host: latestHost, surfaceId });
				return mutations;
			};
			current = host === 'sidebar' ? await this.commitSidebarReveal(plan) : await this.commit(plan);
		}
		if (current) this.presentSurface(surfaceId);
	}

	focusPreviousTab(owner: FocusOwner, focusSurface: (surfaceId: string) => void): boolean {
		return this.#focusAdjacentTab(owner, -1, focusSurface);
	}

	focusNextTab(owner: FocusOwner, focusSurface: (surfaceId: string) => void): boolean {
		return this.#focusAdjacentTab(owner, 1, focusSurface);
	}

	toggleFocusBetweenMainAndSidebar(
		owner: FocusOwner,
		focusSurface: (surfaceId: string) => void,
	): void {
		const snapshot = this.layout.snapshot;
		const sidebarSurfaceId = snapshot.sidebar.activeId;
		if (
			this.isMobile ||
			this.#sidebarOverlayMode ||
			!snapshot.sidebarOpen ||
			snapshot.manualFullscreen ||
			!sidebarSurfaceId
		) {
			return;
		}
		const ownerHost =
			owner.kind === 'host-chrome'
				? owner.host
				: owner.kind === 'surface'
					? this.#presentationHostOf(owner.surfaceId)
					: null;
		focusSurface(ownerHost === 'sidebar' ? this.activeMainId : sidebarSurfaceId);
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
		let current: boolean;
		try {
			current = await this.commit((latest) => this.#mobilePresentation.planDesktopReturn(latest), {
				presentationMode: 'desktop',
			});
		} catch (error) {
			if (
				responsiveGeneration === this.#responsiveGeneration &&
				this.#presentationMode !== 'desktop'
			) {
				this.#requestedPresentationMode = 'mobile';
				this.#setPresentationMode('mobile');
			}
			throw error;
		}
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
					kind === 'commit'
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

	commitThroughSidebarOverlay(commit: () => Promise<boolean>): Promise<boolean> {
		return this.#sidebarOverlayMode
			? this.deps.transientLayers.open('main-inert', commit)
			: commit();
	}

	commitSidebarReveal(
		plan: WorkspaceMutationPlan,
		options: WorkspaceCommitOptions = {},
	): Promise<boolean> {
		const commit = () => this.commit(plan, options);
		return this.#sidebarOverlayMode &&
			(isSidebarHidden(this.layout.snapshot) || this.#inFlightCommitCount > 0)
			? this.deps.transientLayers.open('main-inert', commit)
			: commit();
	}

	async commitDestroyedRemoval(
		surfaceId: string,
		mutations: WorkspaceMutationPlan,
	): Promise<boolean> {
		try {
			return await this.commit(mutations, { requiredPublication: true });
		} catch (error) {
			if (!this.layout.surface(surfaceId)) {
				console.error('Required workspace removal completed with degraded follow-up work', error);
				return true;
			}
			console.error('Retrying required workspace removal after a publication failure', error);
			const removed = await this.deps.arbiter.commit(
				(latest) => (latest.surfaces[surfaceId] ? [{ type: 'remove-surface', surfaceId }] : []),
				{},
				{ retryPublishFailure: true },
			);
			if (!removed || this.layout.surface(surfaceId)) {
				throw new Error(`Required workspace removal failed for ${surfaceId}`, { cause: error });
			}
			return true;
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
		const host =
			owner.kind === 'host-chrome' ? owner.host : this.hostOfSnapshot(snapshot, owner.surfaceId);
		if (!host || (host === 'sidebar' && (!snapshot.sidebarOpen || snapshot.manualFullscreen))) {
			return false;
		}
		const hostState = snapshot[host];
		if (hostState.activeId !== owner.surfaceId) return false;
		const activeIndex = hostState.activeId ? hostState.order.indexOf(hostState.activeId) : -1;
		if (activeIndex < 0) return false;
		const nextSurfaceId = hostState.order[activeIndex + offset];
		if (nextSurfaceId) focusSurface(nextSurfaceId);
		return true;
	}

	#presentationHostOf(surfaceId: string): PresentationHostId | null {
		const snapshot = this.layout.snapshot;
		if (this.#presentationMode === 'mobile') {
			return snapshot.mobileActiveSurfaceId === surfaceId ? 'mobile' : null;
		}
		if (snapshot.dialogFileSurfaceId === surfaceId) return 'dialog';
		if (snapshot.main.activeId === surfaceId) return 'main';
		if (
			snapshot.sidebarOpen &&
			!snapshot.manualFullscreen &&
			snapshot.sidebar.activeId === surfaceId
		) {
			return 'sidebar';
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
		if (this.focusOwner.kind === 'chat-list') return;
		const visible = new Set(this.#visiblePresentations(snapshot, mode).values());
		if (visible.has(this.focusOwner.surfaceId)) return;
		const fallback =
			(visible.has(this.lastFocusedSurfaceId) ? this.lastFocusedSurfaceId : null) ??
			(mode === 'mobile'
				? snapshot.mobileActiveSurfaceId
				: (snapshot.main.activeId ?? CHAT_SURFACE_ID));
		this.focusOwner = { kind: 'surface', surfaceId: fallback };
		this.lastFocusedSurfaceId = fallback;
	}

	#isChatPresentedInSnapshot(
		snapshot: WorkspaceLayoutSnapshot,
		mode: PresentationMode = this.#presentationMode,
	): boolean {
		return mode === 'mobile'
			? snapshot.mobileActiveSurfaceId === CHAT_SURFACE_ID
			: snapshot.main.activeId === CHAT_SURFACE_ID;
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
