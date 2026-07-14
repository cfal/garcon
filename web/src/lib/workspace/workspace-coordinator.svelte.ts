import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import type { TerminalRegistry } from '$lib/stores/terminal-registry.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import {
	CHAT_SURFACE_ID,
	PORTABLE_SINGLETON_KINDS,
	portableSingletonDescriptor,
	singletonSurfaceId,
	type DesktopPlacement,
	type HostId,
	type FocusOwner,
	type PortableSingletonKind,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
	type PresentationHostId,
} from './surface-types.js';
import {
	WorkspaceTransitionArbiter,
	type WorkspaceMutationPlan,
} from './workspace-transition-arbiter.js';
import type { ChatInteractionGate } from './chat-interaction-gate.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';
import { selectMobileEntrySurface } from './responsive-handoff.js';
import type {
	FilePlacementPort,
	FilePlacementResult,
	FileSessionRegistry,
} from '$lib/stores/file-sessions.svelte.js';
import { fileSurfaceId } from './surface-types.js';
import type { GitMutationCoordinator } from '$lib/stores/git/git-mutations.svelte.js';
import type { SingletonSurfaceRegistry } from '$lib/stores/singleton-surfaces.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import type { SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import { visiblePresentationMap } from './visible-presentations.js';
import { FileDialogCoordinator } from './file-dialog-coordinator.js';
import { MobilePresentationPlanner } from './mobile-presentation-planner.js';
import { TerminalPlacementService } from './terminal-placement-service.js';
import type { WorkspaceCommitOptions } from './workspace-commit.js';
import { WorkspacePresentationFrames } from './workspace-presentation-frames.svelte.js';
import {
	canOmitCanonicalPullRequests,
	canOpenCanonicalSidebar,
	nextSidebarSeedKind,
} from './canonical-layout.js';

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

class WorkspacePublicationInvariantError extends Error {
	constructor(
		message = 'Workspace transition arbitration failed to publish a serialized layout update',
	) {
		super(message);
		this.name = 'WorkspacePublicationInvariantError';
	}
}

export class WorkspaceCoordinator implements FilePlacementPort {
	readonly #deps: WorkspaceCoordinatorDeps;
	lastFocusedSurfaceId = $state(CHAT_SURFACE_ID as string);
	focusOwner = $state<FocusOwner>({ kind: 'surface', surfaceId: CHAT_SURFACE_ID });
	#sidebarOverlayMode = false;
	#reservedSurfaceIds = new SvelteSet<string>();
	#presentationMode = $state<'desktop' | 'mobile'>('desktop');
	#requestedPresentationMode: 'desktop' | 'mobile' = 'desktop';
	#responsiveGeneration = 0;
	readonly #mobilePresentation: MobilePresentationPlanner;
	readonly #presentationFrames: WorkspacePresentationFrames;
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
		this.#mobilePresentation = new MobilePresentationPlanner({
			getContext: () => this.#deps.workspaceContext.current,
			getRouteIdentity: deps.getRouteIdentity,
		});
		this.#presentationFrames = new WorkspacePresentationFrames({
			frames: deps.surfaceFrames,
			terminals: deps.terminals,
			files: deps.files,
		});
		const commit = (mutations: WorkspaceMutationPlan, options?: WorkspaceCommitOptions) =>
			this.#commit(mutations, options);
		this.#fileDialog = new FileDialogCoordinator({
			layout: deps.arbiter.layout,
			files: deps.files,
			chatInteractionGate: deps.chatInteractionGate,
			reservations: this.#reservedSurfaceIds,
			commit,
			isMobile: () => this.isMobile,
			responsiveGeneration: () => this.#responsiveGeneration,
			activeMainId: () => this.activeMainId,
			activeSidebarId: () => this.activeSidebarId,
			lastFocusedSurfaceId: () => this.lastFocusedSurfaceId,
			hostOf: (surfaceId) => this.#hostOf(surfaceId),
			eligibleDesktopReturn: (surfaceId) => this.#eligibleDesktopReturn(surfaceId),
			present: (surfaceId) => this.#presentSurface(surfaceId),
			placeOnMobile: (sessionId, surfaceId, publication) =>
				this.#placeFileSessionOnMobile(sessionId, surfaceId, publication),
		});
		this.#terminalPlacement = new TerminalPlacementService({
			layout: deps.arbiter.layout,
			terminals: deps.terminals,
			reservations: this.#reservedSurfaceIds,
			commit,
			commitDestroyedRemoval: (surfaceId, mutations) =>
				this.#commitDestroyedRemoval(surfaceId, mutations),
			currentProjectPath: () => deps.workspaceContext.current?.projectPath ?? null,
			isMobile: () => this.isMobile,
			isChatPresented: () => this.isChatPresented,
			cancelChatTransition: () => deps.chatInteractionGate.cancelBeforeInertTransition(),
			hostOf: (surfaceId) => this.#hostOf(surfaceId),
			activeMainId: () => this.activeMainId,
			activeSidebarId: () => this.activeSidebarId,
			lastFocusedSurfaceId: () => this.lastFocusedSurfaceId,
			focusSurface: (surfaceId) => this.focusSurface(surfaceId),
			present: (surfaceId) => this.#presentSurface(surfaceId),
			resolveMobileReturn: (excluding, snapshot) =>
				this.#mobilePresentation.resolveReturn(excluding, snapshot ?? this.layout.snapshot),
			confirmClose: (request) => this.#confirmClose(request),
			clearAttachmentError: (surfaceId) => this.#presentationFrames.clearError(surfaceId),
		});
		this.#presentationMode = deps.appShell.isMobile ? 'mobile' : 'desktop';
		this.#requestedPresentationMode = this.#presentationMode;
		this.#deps.chatInteractionGate.setPresented(
			this.#isChatPresentedInSnapshot(this.layout.snapshot, this.#presentationMode),
		);
		this.#syncSingletonVisibility(this.layout.snapshot, this.#presentationMode);
	}

	get layout() {
		return this.#deps.arbiter.layout;
	}

	get isMobile(): boolean {
		return this.#presentationMode === 'mobile';
	}

	isSurfacePresented(surfaceId: string): boolean {
		return this.#isSurfacePresented(surfaceId);
	}

	get activeMainId(): string {
		return this.layout.snapshot.main.activeId ?? CHAT_SURFACE_ID;
	}

	get activeSidebarId(): string | null {
		return this.layout.snapshot.sidebar.activeId;
	}

	get canOpenSidebar(): boolean {
		return canOpenCanonicalSidebar(this.layout.snapshot);
	}

	get isChatPresented(): boolean {
		return this.isMobile
			? this.layout.snapshot.mobileActiveSurfaceId === CHAT_SURFACE_ID
			: this.activeMainId === CHAT_SURFACE_ID;
	}

	get isChatInteractive(): boolean {
		return this.isChatPresented && !this.#deps.transientLayers.makesMainInert;
	}

	frameVersion(surfaceId: string): number {
		return this.#presentationFrames.version(surfaceId);
	}

	get attachmentErrors(): Readonly<Record<string, string>> {
		return this.#presentationFrames.errors;
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
		if (!this.#isSurfacePresented(surfaceId)) return;
		this.focusOwner = { kind: 'surface', surfaceId };
		this.lastFocusedSurfaceId = surfaceId;
	}

	noteChatListFocus(): void {
		this.focusOwner = { kind: 'chat-list' };
	}

	noteHostChromeFocus(host: HostId, surfaceId: string): void {
		if (!this.#isSurfacePresented(surfaceId)) return;
		this.focusOwner = { kind: 'host-chrome', host, surfaceId };
	}

	async focusChat(): Promise<void> {
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		await this.#presentChat();
	}

	async #presentChat(): Promise<void> {
		const current = this.isMobile
			? await this.#commit([
					{ type: 'set-mobile-presentation', activeId: CHAT_SURFACE_ID, returnStack: [] },
				])
			: await this.#commit([{ type: 'focus-host', host: 'main', surfaceId: CHAT_SURFACE_ID }]);
		if (!current) return;
		this.#presentSurface(CHAT_SURFACE_ID);
	}

	async focusSurface(surfaceId: string): Promise<void> {
		if (this.#reservedSurfaceIds.has(surfaceId)) return;
		const host = this.#hostOf(surfaceId);
		if (!host) return;
		if (surfaceId !== CHAT_SURFACE_ID && this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		let current: boolean;
		if (this.isMobile) {
			current = await this.#commit((latest) =>
				latest.surfaces[surfaceId]
					? [{ type: 'set-mobile-presentation', activeId: surfaceId, returnStack: [] }]
					: [],
			);
		} else {
			const commit = () =>
				this.#commit((latest) => {
					const latestHost = this.#hostOfSnapshot(latest, surfaceId);
					if (!latestHost) return [];
					const mutations: WorkspaceLayoutMutation[] = [];
					if (latestHost === 'sidebar' && !latest.sidebarOpen) {
						mutations.push({ type: 'set-sidebar-open', open: true });
					}
					mutations.push({ type: 'focus-host', host: latestHost, surfaceId });
					return mutations;
				});
			if (host === 'sidebar' && !this.layout.snapshot.sidebarOpen) {
				current = await this.#commitThroughSidebarOverlay(commit);
			} else {
				current = await commit();
			}
		}
		if (!current) return;
		this.#presentSurface(surfaceId);
	}

	focusPreviousTabInFocusedHost(owner: FocusOwner = this.focusOwner): boolean {
		return this.#focusAdjacentTabInFocusedHost(owner, -1);
	}

	focusNextTabInFocusedHost(owner: FocusOwner = this.focusOwner): boolean {
		return this.#focusAdjacentTabInFocusedHost(owner, 1);
	}

	toggleFocusBetweenMainAndSidebar(owner: FocusOwner = this.focusOwner): void {
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
		void this.focusSurface(ownerHost === 'sidebar' ? this.activeMainId : sidebarSurfaceId);
	}

	async openSingleton(kind: PortableSingletonKind, preferredHostIfAbsent: HostId): Promise<void> {
		const surfaceId = singletonSurfaceId(kind);
		if (this.layout.surface(surfaceId)) {
			if (this.isMobile || this.#hostOf(surfaceId)) {
				await this.focusSurface(surfaceId);
			} else {
				await this.moveSurface(surfaceId, preferredHostIfAbsent);
			}
			return;
		}
		const surface = portableSingletonDescriptor(kind);
		if (preferredHostIfAbsent === 'main' && this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const commit = () =>
			this.#commit((latest) => {
				const existingHost = this.#hostOfSnapshot(latest, surfaceId);
				if (existingHost) {
					return [
						...(existingHost === 'sidebar' && !latest.sidebarOpen
							? [{ type: 'set-sidebar-open', open: true } as const]
							: []),
						{ type: 'focus-host', host: existingHost, surfaceId },
					];
				}
				if (latest.surfaces[surfaceId]) {
					return [{ type: 'move-to-host', surfaceId, destination: preferredHostIfAbsent }];
				}
				return [
					{ type: 'register-surface', surface, host: preferredHostIfAbsent },
					{ type: 'focus-host', host: preferredHostIfAbsent, surfaceId },
				];
			});
		const current =
			preferredHostIfAbsent === 'sidebar'
				? await this.#commitThroughSidebarOverlay(commit)
				: await commit();
		if (!current) return;
		this.#presentSurface(surfaceId);
	}

	async moveSurface(surfaceId: string, destination: HostId): Promise<void> {
		if (surfaceId === CHAT_SURFACE_ID) return;
		if (this.#reservedSurfaceIds.has(surfaceId)) return;
		if (this.isChatPresented && destination === 'main') {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const commit = () =>
			this.#commit((latest) => {
				if (!latest.surfaces[surfaceId]) return [];
				const mutations: WorkspaceLayoutMutation[] = [];
				if (
					destination === 'sidebar' &&
					latest.manualFullscreen &&
					latest.main.activeId === surfaceId
				) {
					mutations.push({ type: 'set-manual-fullscreen', enabled: false });
				}
				mutations.push({ type: 'move-to-host', surfaceId, destination });
				return mutations;
			});
		const current =
			destination === 'sidebar' && !this.layout.snapshot.sidebarOpen
				? await this.#commitThroughSidebarOverlay(commit)
				: await commit();
		if (!current) return;
		this.#presentSurface(surfaceId);
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
			const sourceHost = this.#hostOf(surfaceId);
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
					const fallback = this.#mobilePresentation.resolveReturn(surfaceId, latest);
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
					? await this.#commit(removalPlan)
					: await this.#commitDestroyedRemoval(surfaceId, removalPlan);
			this.#presentationFrames.clearError(surfaceId);
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
			const fallbackSurfaceId =
				mobileFallbackId ??
				(wasDialog
					? this.#eligibleDesktopReturn(this.#fileDialog.returnSurfaceId)
					: sourceHost === 'sidebar' && this.layout.snapshot.sidebarOpen
						? this.activeSidebarId
						: this.activeMainId) ??
				this.activeMainId;
			this.lastFocusedSurfaceId = fallbackSurfaceId;
			this.#focusPresentedSurface(fallbackSurfaceId);
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
		const destination = target ?? 'dialog';
		if (destination === 'dialog') {
			return this.#fileDialog.placeNew(sessionId, publication);
		}
		if (destination === 'main' && this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const commit = () =>
			this.#commit(
				[
					{
						type: 'register-surface',
						surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
						host: destination,
					},
					{ type: 'focus-host', host: destination, surfaceId },
				],
				{ publication },
			);
		const current =
			destination === 'sidebar' && !this.layout.snapshot.sidebarOpen
				? await this.#commitThroughSidebarOverlay(commit)
				: await commit();
		if (current) this.#presentSurface(surfaceId);
		return 'placed';
	}

	async focusFileSession(sessionId: string): Promise<void> {
		const surfaceId = fileSurfaceId(sessionId);
		if (this.layout.snapshot.dialogFileSurfaceId === surfaceId) {
			this.#presentSurface(surfaceId);
			return;
		}
		if (this.layout.snapshot.mobileOnlySurfaceIds.includes(surfaceId) || this.isMobile) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
			const returnStack = this.#mobilePresentation.returnStackForTransient(
				surfaceId,
				this.layout.snapshot,
				this.isMobile,
			);
			const current = await this.#commit([
				{
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack,
				},
			]);
			if (!current) return;
			this.#presentSurface(surfaceId);
			return;
		}
		await this.focusSurface(surfaceId);
	}

	async popOutFile(surfaceId: string): Promise<boolean> {
		const surface = this.layout.surface(surfaceId);
		if (!surface || surface.type !== 'file') return false;
		return this.#fileDialog.pop(surfaceId);
	}

	async moveDialogFileToHost(destination: HostId): Promise<void> {
		await this.#fileDialog.moveToHost(destination);
	}

	async createTerminal(host: HostId = 'main', requestKey?: string): Promise<string> {
		return this.#terminalPlacement.create(host, requestKey);
	}

	async createTerminalReplacing(currentTerminalId: string, requestKey?: string): Promise<string> {
		return this.#terminalPlacement.createReplacing(currentTerminalId, requestKey);
	}

	async openTerminalSession(terminalId: string, preferredHost: HostId = 'main'): Promise<void> {
		await this.#terminalPlacement.open(terminalId, preferredHost);
	}

	async switchTerminalSurface(currentTerminalId: string, nextTerminalId: string): Promise<void> {
		await this.#terminalPlacement.switch(currentTerminalId, nextTerminalId);
	}

	async handleTerminalSessionTerminated(terminalId: string): Promise<void> {
		await this.#terminalPlacement.handleTerminated(terminalId);
	}

	async focusMostRecentTerminalOrCreate(preferredHost: HostId = 'main'): Promise<void> {
		await this.#terminalPlacement.focusMostRecentOrCreate(preferredHost);
	}

	async openSidebar(): Promise<void> {
		if (!this.canOpenSidebar) return;
		const commit = () =>
			this.#commit((latest) => {
				if (latest.sidebar.order.length > 0) {
					return [{ type: 'set-sidebar-open', open: true }];
				}
				const seedKind = nextSidebarSeedKind(latest);
				if (!seedKind) return [];
				const surfaceId = singletonSurfaceId(seedKind);
				const mutations: WorkspaceLayoutMutation[] = [
					{
						type: 'register-surface',
						surface: portableSingletonDescriptor(seedKind),
						host: 'sidebar',
					},
					{ type: 'focus-host', host: 'sidebar', surfaceId },
					{ type: 'set-sidebar-open', open: true },
				];
				return mutations;
			});
		const current = await this.#commitThroughSidebarOverlay(commit);
		if (!current) return;
		if (this.activeSidebarId) this.#presentSurface(this.activeSidebarId);
	}

	setSidebarOverlayMode(overlay: boolean): void {
		this.#sidebarOverlayMode = overlay;
	}

	async closeSidebar(): Promise<void> {
		const current = await this.#commit([{ type: 'set-sidebar-open', open: false }]);
		if (!current) return;
		this.#presentSurface(this.activeMainId);
	}

	async enterMobilePresentation(): Promise<void> {
		if (this.#requestedPresentationMode === 'mobile') return;
		this.#requestedPresentationMode = 'mobile';
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		const responsiveGeneration = ++this.#responsiveGeneration;
		const from = this.#presentationMode;
		let activeId = CHAT_SURFACE_ID as string;
		let current: boolean;
		try {
			current = await this.#commit(
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
		this.#presentSurface(activeId);
	}

	async exitMobilePresentation(): Promise<void> {
		if (this.#requestedPresentationMode === 'desktop') return;
		this.#requestedPresentationMode = 'desktop';
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		const responsiveGeneration = ++this.#responsiveGeneration;
		let current: boolean;
		try {
			current = await this.#commit((latest) => this.#mobilePresentation.planDesktopReturn(latest), {
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
		this.#focusPresentedSurface(this.lastFocusedSurfaceId);
	}

	async focusMobileSingleton(kind: PortableSingletonKind): Promise<void> {
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		const surfaceId = singletonSurfaceId(kind);
		if (!this.layout.surface(surfaceId)) {
			await this.#commit([
				{ type: 'register-surface', surface: portableSingletonDescriptor(kind) },
			]);
		}
		const current = await this.#commit([
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
		if (!current) return;
		this.#presentSurface(surfaceId);
	}

	async mobileBack(): Promise<void> {
		if (!this.isMobile) return;
		const currentId = this.layout.snapshot.mobileActiveSurfaceId;
		const fallback = this.#mobilePresentation.resolveReturn(currentId, this.layout.snapshot);
		const current = await this.#commit([
			{
				type: 'set-mobile-presentation',
				activeId: fallback.activeId,
				returnStack: fallback.returnStack,
			},
		]);
		if (!current) return;
		this.#presentSurface(fallback.activeId);
	}

	async setSidebarWidth(width: number): Promise<void> {
		await this.#commit([{ type: 'set-sidebar-width', width }]);
	}

	async setManualFullscreen(enabled: boolean): Promise<void> {
		const current = await this.#commit([{ type: 'set-manual-fullscreen', enabled }]);
		if (!current) return;
		if (enabled) this.#presentSurface(this.activeMainId);
	}

	async retryPresentation(surfaceId: string, host: PresentationHostId): Promise<void> {
		if (!this.layout.surface(surfaceId)) return;
		const current = await this.#presentationFrames.retry(surfaceId, host);
		if (!current) return;
		this.#focusPresentedSurface(surfaceId);
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
		await this.#commit([{ type: 'remove-surface', surfaceId: pullRequestsSurfaceId }]);
	}

	async activateTerminalLauncher(host: HostId): Promise<void> {
		await this.#terminalPlacement.activateLauncher(host);
	}

	#hostOf(surfaceId: string): HostId | null {
		return this.#hostOfSnapshot(this.layout.snapshot, surfaceId);
	}

	#isSurfacePresented(surfaceId: string): boolean {
		return [...this.#visiblePresentations(this.layout.snapshot).values()].includes(surfaceId);
	}

	#setPresentationMode(mode: 'desktop' | 'mobile'): void {
		this.#presentationMode = mode;
		this.#deps.appShell.isMobile = mode === 'mobile';
	}

	#hostOfSnapshot(snapshot: WorkspaceLayoutSnapshot, surfaceId: string): HostId | null {
		if (snapshot.main.order.includes(surfaceId)) return 'main';
		if (snapshot.sidebar.order.includes(surfaceId)) return 'sidebar';
		return null;
	}

	#focusAdjacentTabInFocusedHost(owner: FocusOwner, offset: -1 | 1): boolean {
		if (this.isMobile || owner.kind === 'chat-list') return false;
		if (!this.#isSurfacePresented(owner.surfaceId)) return false;
		const snapshot = this.layout.snapshot;
		const host =
			owner.kind === 'host-chrome' ? owner.host : this.#hostOfSnapshot(snapshot, owner.surfaceId);
		if (!host || (host === 'sidebar' && (!snapshot.sidebarOpen || snapshot.manualFullscreen))) {
			return false;
		}
		const hostState = snapshot[host];
		if (hostState.activeId !== owner.surfaceId) return false;
		const activeIndex = hostState.activeId ? hostState.order.indexOf(hostState.activeId) : -1;
		if (activeIndex < 0) return false;
		const nextSurfaceId = hostState.order[activeIndex + offset];
		if (nextSurfaceId) void this.focusSurface(nextSurfaceId);
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
		)
			return 'sidebar';
		return null;
	}

	#focusPresentedSurface(surfaceId: string): void {
		if (surfaceId === CHAT_SURFACE_ID) {
			this.#deps.appShell.requestComposerFocus();
			return;
		}
		const host = this.#presentationHostOf(surfaceId);
		if (host) this.#deps.surfaceFrames?.focus(surfaceId, host);
	}

	#presentSurface(surfaceId: string): void {
		this.lastFocusedSurfaceId = surfaceId;
		if (this.isMobile) this.#mobilePresentation.noteActivation(surfaceId);
		this.#focusPresentedSurface(surfaceId);
	}

	#commitThroughSidebarOverlay(commit: () => Promise<boolean>): Promise<boolean> {
		return this.#sidebarOverlayMode
			? this.#deps.transientLayers.open('main-inert', commit)
			: commit();
	}

	#eligibleDesktopReturn(surfaceId: string | null): string | null {
		if (!surfaceId || !this.layout.surface(surfaceId)) return null;
		const snapshot = this.layout.snapshot;
		if (snapshot.main.order.includes(surfaceId)) return surfaceId;
		if (snapshot.sidebarOpen && snapshot.sidebar.order.includes(surfaceId)) return surfaceId;
		return null;
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
		const returnStack = this.#mobilePresentation.returnStackForTransient(
			surfaceId,
			this.layout.snapshot,
			this.isMobile,
		);
		const current = await this.#commit(
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
		if (current) this.#presentSurface(surfaceId);
		return 'placed';
	}

	async #commitDestroyedRemoval(
		surfaceId: string,
		mutations: WorkspaceMutationPlan,
	): Promise<boolean> {
		try {
			return await this.#commit(mutations, { requiredPublication: true });
		} catch (error) {
			if (!this.layout.surface(surfaceId)) {
				console.error('Required workspace removal completed with degraded follow-up work', error);
				return true;
			}
			console.error('Retrying required workspace removal after a publication failure', error);
			const removed = await this.#deps.arbiter.commit(
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

	async #commit(
		mutations: WorkspaceMutationPlan,
		options: WorkspaceCommitOptions = {},
	): Promise<boolean> {
		let expectations: ReturnType<WorkspacePresentationFrames['prepare']> = [];
		let presentationGeneration: number | null = null;
		let presentationFrom: 'desktop' | 'mobile' | null = null;
		let presentationTo: 'desktop' | 'mobile' | null = null;
		const published = await this.#deps.arbiter.commit(
			mutations,
			{
				beforePublish: (next, base) => {
					presentationTo = options.presentationMode ?? this.#presentationMode;
					try {
						if (options.presentationMode) {
							presentationFrom = this.#presentationMode;
							this.#setPresentationMode(options.presentationMode);
						}
						this.#deps.chatInteractionGate.setPresented(
							this.#isChatPresentedInSnapshot(next, presentationTo),
						);
						this.#hideLeavingSingletons(
							base,
							next,
							presentationFrom ?? this.#presentationMode,
							presentationTo,
						);
						options.publication?.publish();
						presentationGeneration = this.#presentationFrames.beginTransition(
							base,
							next,
							presentationFrom ?? this.#presentationMode,
							presentationTo,
						);
						expectations = this.#presentationFrames.prepare(
							base,
							next,
							presentationFrom ?? this.#presentationMode,
							presentationTo,
						);
					} catch (error) {
						if (!options.requiredPublication) throw error;
						expectations = [];
						this.#presentationFrames.recordPreparationError(next, error, presentationTo);
					}
				},
				publishFailed: () => {
					try {
						if (presentationFrom) this.#setPresentationMode(presentationFrom);
						this.#deps.chatInteractionGate.setPresented(
							this.#isChatPresentedInSnapshot(this.layout.snapshot, presentationFrom ?? undefined),
						);
						this.#syncSingletonVisibility(this.layout.snapshot, presentationFrom ?? undefined);
						options.publication?.rollback();
						this.#presentationFrames.cancel(expectations);
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
			this.#deps.onLayoutChanged?.(this.layout.snapshot);
		} catch (error) {
			if (!options.requiredPublication) throw error;
			console.error('Failed to persist required workspace layout publication', error);
		}
		await Promise.all(
			expectations.map((expectation) => this.#presentationFrames.settle(expectation)),
		);
		return this.#presentationFrames.isTransitionCurrent(presentationGeneration);
	}

	#normalizeFocusOwner(
		snapshot: WorkspaceLayoutSnapshot,
		mode: 'desktop' | 'mobile' = this.#presentationMode,
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
		mode: 'desktop' | 'mobile' = this.#presentationMode,
	): boolean {
		return mode === 'mobile'
			? snapshot.mobileActiveSurfaceId === CHAT_SURFACE_ID
			: snapshot.main.activeId === CHAT_SURFACE_ID;
	}

	#syncSingletonVisibility(
		snapshot: WorkspaceLayoutSnapshot,
		mode: 'desktop' | 'mobile' = this.#presentationMode,
	): void {
		const visibleSurfaceIds = new Set(this.#visiblePresentations(snapshot, mode).values());
		for (const kind of PORTABLE_SINGLETON_KINDS) {
			this.#deps.singletons.setPresentationVisible(
				kind,
				visibleSurfaceIds.has(singletonSurfaceId(kind)),
			);
		}
	}

	#hideLeavingSingletons(
		base: WorkspaceLayoutSnapshot,
		next: WorkspaceLayoutSnapshot,
		fromMode: 'desktop' | 'mobile' = this.#presentationMode,
		toMode: 'desktop' | 'mobile' = this.#presentationMode,
	): void {
		const before = new Set(this.#visiblePresentations(base, fromMode).values());
		const after = new Set(this.#visiblePresentations(next, toMode).values());
		for (const kind of PORTABLE_SINGLETON_KINDS) {
			const surfaceId = singletonSurfaceId(kind);
			if (before.has(surfaceId) && !after.has(surfaceId)) {
				this.#deps.singletons.setPresentationVisible(kind, false);
			}
		}
	}

	#visiblePresentations(
		snapshot: WorkspaceLayoutSnapshot,
		mode: 'desktop' | 'mobile' = this.#presentationMode,
	): Map<PresentationHostId, string> {
		return visiblePresentationMap(snapshot, mode);
	}
}
