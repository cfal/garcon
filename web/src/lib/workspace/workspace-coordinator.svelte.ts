import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import {
	CHAT_SURFACE_ID,
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
import {
	canOmitCanonicalPullRequests,
	canOpenCanonicalSidebar,
	nextSidebarSeedKind,
} from './canonical-layout.js';
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

function revealSidebarMutations(snapshot: WorkspaceLayoutSnapshot): WorkspaceLayoutMutation[] {
	const mutations: WorkspaceLayoutMutation[] = [];
	if (snapshot.manualFullscreen) {
		mutations.push({ type: 'set-manual-fullscreen', enabled: false });
	}
	if (!snapshot.sidebarOpen) mutations.push({ type: 'set-sidebar-open', open: true });
	return mutations;
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
			activeMainId: () => this.activeMainId,
			activeSidebarId: () => this.activeSidebarId,
			lastFocusedSurfaceId: () => this.lastFocusedSurfaceId,
			hostOf: (surfaceId) => this.#presentation.hostOf(surfaceId),
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
				this.#presentation.commitDestroyedRemoval(surfaceId, mutations),
			currentProjectPath: () => deps.workspaceContext.current?.projectPath ?? null,
			isMobile: () => this.isMobile,
			isChatPresented: () => this.isChatPresented,
			cancelChatTransition: () => deps.chatInteractionGate.cancelBeforeInertTransition(),
			hostOf: (surfaceId) => this.#presentation.hostOf(surfaceId),
			activeMainId: () => this.activeMainId,
			activeSidebarId: () => this.activeSidebarId,
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

	get activeMainId(): string {
		return this.#presentation.activeMainId;
	}

	get activeSidebarId(): string | null {
		return this.#presentation.activeSidebarId;
	}

	get canOpenSidebar(): boolean {
		return canOpenCanonicalSidebar(this.layout.snapshot);
	}

	get isChatPresented(): boolean {
		return this.#presentation.isChatPresented;
	}

	get isChatInteractive(): boolean {
		return this.#presentation.isChatInteractive;
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

	noteHostChromeFocus(host: HostId, surfaceId: string): void {
		this.#presentation.noteHostChromeFocus(host, surfaceId);
	}

	async focusChat(): Promise<void> {
		await this.#presentation.focusChat();
	}

	async focusSurface(surfaceId: string): Promise<void> {
		await this.#presentation.focusSurface(surfaceId, this.#reservedSurfaceIds);
	}

	focusPreviousTabInFocusedHost(owner: FocusOwner = this.focusOwner): boolean {
		return this.#presentation.focusPreviousTab(
			owner,
			(surfaceId) => void this.focusSurface(surfaceId),
		);
	}

	focusNextTabInFocusedHost(owner: FocusOwner = this.focusOwner): boolean {
		return this.#presentation.focusNextTab(owner, (surfaceId) => void this.focusSurface(surfaceId));
	}

	toggleFocusBetweenMainAndSidebar(owner: FocusOwner = this.focusOwner): void {
		this.#presentation.toggleFocusBetweenMainAndSidebar(
			owner,
			(surfaceId) => void this.focusSurface(surfaceId),
		);
	}

	async openSingleton(kind: PortableSingletonKind, preferredHostIfAbsent: HostId): Promise<void> {
		const surfaceId = singletonSurfaceId(kind);
		if (this.layout.surface(surfaceId)) {
			if (this.isMobile || this.#presentation.hostOf(surfaceId)) {
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
			this.#presentation.commit((latest) => {
				const existingHost = this.#presentation.hostOfSnapshot(latest, surfaceId);
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
				? await this.#presentation.commitThroughSidebarOverlay(commit)
				: await commit();
		if (!current) return;
		this.#presentation.presentSurface(surfaceId);
	}

	async moveSurface(surfaceId: string, destination: HostId): Promise<void> {
		if (surfaceId === CHAT_SURFACE_ID) return;
		if (this.#reservedSurfaceIds.has(surfaceId)) return;
		if (this.isChatPresented && destination === 'main') {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const commit = () =>
			this.#presentation.commit((latest) => {
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
				? await this.#presentation.commitThroughSidebarOverlay(commit)
				: await commit();
		if (!current) return;
		this.#presentation.presentSurface(surfaceId);
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
			const sourceHost = this.#presentation.hostOf(surfaceId);
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
					: await this.#presentation.commitDestroyedRemoval(surfaceId, removalPlan);
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
			const fallbackSurfaceId =
				mobileFallbackId ??
				(wasDialog
					? this.#presentation.eligibleDesktopReturn(this.#fileDialog.returnSurfaceId)
					: sourceHost === 'sidebar' && this.layout.snapshot.sidebarOpen
						? this.activeSidebarId
						: this.activeMainId) ??
				this.activeMainId;
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
		const destination = target ?? 'dialog';
		if (destination === 'dialog') {
			return this.#fileDialog.placeNew(sessionId, publication);
		}
		if (destination === 'main' && this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const plan = (latest: WorkspaceLayoutSnapshot): readonly WorkspaceLayoutMutation[] => [
			...(destination === 'sidebar' ? revealSidebarMutations(latest) : []),
			{
				type: 'register-surface',
				surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
				host: destination,
			},
			{ type: 'focus-host', host: destination, surfaceId },
		];
		const current =
			destination === 'sidebar'
				? await this.#presentation.commitSidebarReveal(plan, { publication })
				: await this.#presentation.commit(plan, { publication });
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
			this.#presentation.commit((latest) => {
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
		const current = await this.#presentation.commitThroughSidebarOverlay(commit);
		if (!current) return;
		if (this.activeSidebarId) this.#presentation.presentSurface(this.activeSidebarId);
	}

	setSidebarOverlayMode(overlay: boolean): void {
		this.#presentation.setSidebarOverlayMode(overlay);
	}

	async closeSidebar(): Promise<void> {
		const current = await this.#presentation.commit([{ type: 'set-sidebar-open', open: false }]);
		if (!current) return;
		this.#presentation.presentSurface(this.activeMainId);
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

	async setSidebarWidth(width: number): Promise<void> {
		await this.#presentation.commit([{ type: 'set-sidebar-width', width }]);
	}

	async setManualFullscreen(enabled: boolean): Promise<void> {
		const current = await this.#presentation.commit([{ type: 'set-manual-fullscreen', enabled }]);
		if (!current) return;
		if (enabled) this.#presentation.presentSurface(this.activeMainId);
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

	async activateTerminalLauncher(host: HostId): Promise<void> {
		await this.#terminalPlacement.activateLauncher(host);
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
