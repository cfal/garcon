import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import type { ChatSessionsStore } from '$lib/stores/chat-sessions.svelte.js';
import type { TerminalRegistry } from '$lib/stores/terminal-registry.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import {
	CHAT_SURFACE_ID,
	singletonSurfaceId,
	terminalSurfaceId,
	type HostId,
	type MobileReturnTarget,
	type FocusOwner,
	type PortableSingletonKind,
	type SurfaceDescriptor,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
	type PresentationHostId,
} from './surface-types.js';
import { WorkspaceTransitionArbiter } from './workspace-transition-arbiter.js';
import type { ChatInteractionGate } from './chat-interaction-gate.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';
import { planDesktopReturnMutations, selectMobileEntrySurface } from './responsive-handoff.js';
import type { FilePlacementPort, FileSessionRegistry } from '$lib/stores/file-sessions.svelte.js';
import { fileSurfaceId } from './surface-types.js';
import type { GitMutationCoordinator } from '$lib/stores/git-mutations.svelte.js';
import type { SingletonSurfaceRegistry } from '$lib/stores/singleton-surfaces.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import type { FrameExpectation, SurfaceFrameRegistry } from './surface-frame-registry.svelte.js';
import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';

function singletonDescriptor(kind: PortableSingletonKind): SurfaceDescriptor {
	switch (kind) {
		case 'git':
			return { id: 'singleton:git', type: 'singleton', kind };
		case 'pull-requests':
			return { id: 'singleton:pull-requests', type: 'singleton', kind };
		case 'files':
			return { id: 'singleton:files', type: 'singleton', kind };
		case 'quick-git':
			return { id: 'singleton:quick-git', type: 'singleton', kind };
	}
}

interface WorkspaceCoordinatorDeps {
	arbiter: WorkspaceTransitionArbiter;
	terminals: TerminalRegistry;
	workspaceContext: WorkspaceContextStore;
	appShell: AppShellStore;
	chatSessions: ChatSessionsStore;
	chatInteractionGate: ChatInteractionGate;
	transientLayers: TransientLayerRegistry;
	files: FileSessionRegistry;
	singletons: SingletonSurfaceRegistry;
	gitMutations?: GitMutationCoordinator;
	surfaceFrames?: SurfaceFrameRegistry;
	onLayoutChanged?(snapshot: import('./surface-types.js').WorkspaceLayoutSnapshot): void;
	onTerminalLauncherDismissed?(): void;
	getRouteIdentity(): string;
}

export class WorkspaceCoordinator implements FilePlacementPort {
	readonly #deps: WorkspaceCoordinatorDeps;
	lastFocusedSurfaceId = $state(CHAT_SURFACE_ID as string);
	focusOwner = $state<FocusOwner>({ kind: 'surface', surfaceId: CHAT_SURFACE_ID });
	#mobileMruSurfaceIds: string[] = [CHAT_SURFACE_ID];
	#sidebarOverlayMode = false;
	#reservedSurfaceIds = new SvelteSet<string>();
	#dialogTail: Promise<void> = Promise.resolve();
	#dialogReturnSurfaceId: string | null = null;
	#terminalCreateRequestIds = new Map<string, string>();
	#terminalTerminateRequestIds = new Map<string, string>();
	#presentationMode: 'desktop' | 'mobile';
	#responsiveGeneration = 0;
	#presentationGeneration = 0;
	frameVersions = $state<Record<string, number>>({});
	attachmentErrors = $state<Record<string, string>>({});
	closeGuardRequest = $state<{
		surfaceId: string;
		title: string;
		description: string;
		confirmLabel: string;
	} | null>(null);
	#closeGuardResolve: ((confirmed: boolean) => void) | null = null;

	constructor(deps: WorkspaceCoordinatorDeps) {
		this.#deps = deps;
		this.#presentationMode = deps.appShell.isMobile ? 'mobile' : 'desktop';
		this.#deps.chatInteractionGate.setPresented(
			this.#isChatPresentedInSnapshot(this.layout.snapshot, this.#presentationMode),
		);
		this.#syncSingletonVisibility(this.layout.snapshot, this.#presentationMode);
	}

	get layout() {
		return this.#deps.arbiter.layout;
	}

	get isMobile(): boolean {
		return this.#deps.appShell.isMobile;
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
		return this.isChatPresented && !this.#deps.transientLayers.makesMainInert;
	}

	frameVersion(surfaceId: string): number {
		return this.frameVersions[surfaceId] ?? 0;
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
		if (surface.type === 'singleton' && surface.kind === 'quick-git') {
			return !this.#deps.singletons.quickGit.canClose;
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

	async selectChat(chatId: string): Promise<void> {
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		this.#deps.chatSessions.setSelectedChatId(chatId);
		await this.#presentChat();
	}

	async #presentChat(): Promise<void> {
		const current = this.isMobile
			? await this.#commit([
					{ type: 'set-mobile-presentation', activeId: CHAT_SURFACE_ID, returnStack: [] },
				])
			: await this.#commit([{ type: 'focus-host', host: 'main', surfaceId: CHAT_SURFACE_ID }]);
		if (!current) return;
		this.lastFocusedSurfaceId = CHAT_SURFACE_ID;
		if (this.isMobile) this.#noteMobileActivation(CHAT_SURFACE_ID);
		this.#focusPresentedSurface(CHAT_SURFACE_ID);
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
			if (host === 'sidebar' && !this.layout.snapshot.sidebarOpen && this.#sidebarOverlayMode) {
				current = await this.#deps.transientLayers.open('main-inert', commit);
			} else {
				current = await commit();
			}
		}
		if (!current) return;
		this.lastFocusedSurfaceId = surfaceId;
		if (this.isMobile) this.#noteMobileActivation(surfaceId);
		this.#focusPresentedSurface(surfaceId);
	}

	async openSingleton(kind: PortableSingletonKind, preferredHostIfAbsent: HostId): Promise<void> {
		const surfaceId = singletonSurfaceId(kind);
		if (this.layout.surface(surfaceId)) {
			await this.focusSurface(surfaceId);
			return;
		}
		const surface = singletonDescriptor(kind);
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
			preferredHostIfAbsent === 'sidebar' && this.#sidebarOverlayMode
				? await this.#deps.transientLayers.open('main-inert', commit)
				: await commit();
		if (!current) return;
		this.lastFocusedSurfaceId = surfaceId;
		this.#focusPresentedSurface(surfaceId);
	}

	async moveSurface(surfaceId: string, destination: HostId): Promise<void> {
		if (surfaceId === CHAT_SURFACE_ID) return;
		if (this.#reservedSurfaceIds.has(surfaceId)) return;
		if (this.isChatPresented && destination === 'main') {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const mutations: WorkspaceLayoutMutation[] = [];
		if (
			destination === 'sidebar' &&
			this.layout.snapshot.manualFullscreen &&
			this.activeMainId === surfaceId
		) {
			mutations.push({ type: 'set-manual-fullscreen', enabled: false });
		}
		mutations.push({ type: 'move-to-host', surfaceId, destination });
		const commit = () => this.#commit(mutations);
		const current =
			destination === 'sidebar' && !this.layout.snapshot.sidebarOpen && this.#sidebarOverlayMode
				? await this.#deps.transientLayers.open('main-inert', commit)
				: await commit();
		if (!current) return;
		this.lastFocusedSurfaceId = surfaceId;
		this.#focusPresentedSurface(surfaceId);
	}

	async closeSurface(surfaceId: string): Promise<boolean> {
		const surface = this.layout.surface(surfaceId);
		if (!surface || this.isSurfaceCloseBlocked(surfaceId)) return false;
		this.#reservedSurfaceIds.add(surfaceId);
		try {
			if (surface.type === 'terminal') {
				const session = this.#deps.terminals.sessions[surface.terminalId];
				if (
					session &&
					(session.metadata.processStatus === 'running' ||
						session.attachmentState === 'attached') &&
					!(await this.#confirmClose({
						surfaceId,
						title: m.terminal_close_title({ number: session.metadata.displaySequence }),
						description: m.terminal_close_description(),
						confirmLabel: m.terminal_terminate(),
					}))
				)
					return false;
				await this.#requestTerminalTermination(surface.terminalId);
			}
			if (surface.type === 'singleton' && surface.kind === 'quick-git') {
				if (!this.#deps.singletons.quickGit.canClose) return false;
				const draftCount = this.#deps.singletons.quickGit.retainedDraftCount;
				if (
					draftCount > 0 &&
					!(await this.#confirmClose({
						surfaceId,
						title: m.quick_git_close_title(),
						description:
							draftCount === 1
								? m.quick_git_close_drafts_singular()
								: m.quick_git_close_drafts_plural({ count: draftCount }),
						confirmLabel: m.quick_git_discard_close(),
					}))
				)
					return false;
				this.#deps.singletons.quickGit.discardDrafts();
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
			const mutations: WorkspaceLayoutMutation[] = [{ type: 'remove-surface', surfaceId }];
			let mobileFallbackId: string | null = null;
			if (this.isMobile && this.layout.snapshot.mobileActiveSurfaceId === surfaceId) {
				const fallback = this.#resolveMobileReturn(surfaceId);
				mobileFallbackId = fallback.activeId;
				mutations.push({
					type: 'set-mobile-presentation',
					activeId: fallback.activeId,
					returnStack: fallback.returnStack,
				});
			}
			const current = await this.#commit(
				(latest) => (latest.surfaces[surfaceId] ? mutations : []),
				undefined,
				undefined,
				{
					guaranteedRemoval: true,
				},
			);
			this.#clearAttachmentError(surfaceId);
			if (wasDialog) this.#dialogReturnSurfaceId = null;
			if (surface.type === 'terminal') {
				this.#terminalTerminateRequestIds.delete(surface.terminalId);
				this.#deps.terminals.disposeTerminatedSession(surface.terminalId);
			}
			if (surface.type === 'file') this.#deps.files.destroy(surface.fileSessionId);
			if (surface.type === 'terminal-launcher') this.#deps.onTerminalLauncherDismissed?.();
			if (surface.type === 'singleton' && surface.kind !== 'chat') {
				this.#deps.singletons.disposeSurface(surface.kind);
			}
			if (!current) return true;
			const fallbackSurfaceId =
				mobileFallbackId ??
				(wasDialog
					? this.#eligibleDesktopReturn(this.#dialogReturnSurfaceId)
					: sourceHost === 'sidebar' && this.layout.snapshot.sidebarOpen
						? this.activeSidebarId
						: this.activeMainId) ??
				this.activeMainId;
			this.lastFocusedSurfaceId = fallbackSurfaceId;
			this.#focusPresentedSurface(fallbackSurfaceId);
			return true;
		} finally {
			this.#reservedSurfaceIds.delete(surfaceId);
		}
	}

	resolveCloseGuard(confirmed: boolean): void {
		const resolve = this.#closeGuardResolve;
		this.#closeGuardResolve = null;
		this.closeGuardRequest = null;
		resolve?.(confirmed);
	}

	async placeFileSession(
		sessionId: string,
		target?: HostId | 'dialog',
		publication?: { publish(): void; rollback(): void },
	): Promise<boolean> {
		const surfaceId = fileSurfaceId(sessionId);
		if (this.layout.surface(surfaceId)) {
			await this.focusFileSession(sessionId);
			return true;
		}
		if (this.isMobile) {
			return this.#placeFileSessionOnMobile(sessionId, surfaceId, publication);
		}
		const destination = target ?? 'dialog';
		if (destination === 'dialog') {
			return this.#withDialogTurn(() =>
				this.#placeNewFileInDialog(sessionId, surfaceId, publication),
			);
		}
		if (destination === 'main' && this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const current = await this.#commit(
			[
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
					host: destination,
				},
				{ type: 'focus-host', host: destination, surfaceId },
			],
			publication,
		);
		if (!current) return true;
		this.lastFocusedSurfaceId = surfaceId;
		this.#focusPresentedSurface(surfaceId);
		return true;
	}

	async focusFileSession(sessionId: string): Promise<void> {
		const surfaceId = fileSurfaceId(sessionId);
		if (this.layout.snapshot.dialogFileSurfaceId === surfaceId) {
			this.lastFocusedSurfaceId = surfaceId;
			this.#focusPresentedSurface(surfaceId);
			return;
		}
		if (this.layout.snapshot.mobileOnlySurfaceIds.includes(surfaceId) || this.isMobile) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
			const returnStack = this.#returnStackForTransient(surfaceId);
			const current = await this.#commit([
				{
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack,
				},
			]);
			if (!current) return;
			this.lastFocusedSurfaceId = surfaceId;
			this.#noteMobileActivation(surfaceId);
			this.#focusPresentedSurface(surfaceId);
			return;
		}
		await this.focusSurface(surfaceId);
	}

	async popOutFile(surfaceId: string): Promise<boolean> {
		const surface = this.layout.surface(surfaceId);
		if (
			!surface ||
			surface.type !== 'file' ||
			this.isMobile ||
			this.#reservedSurfaceIds.has(surfaceId)
		)
			return false;
		this.#reservedSurfaceIds.add(surfaceId);
		try {
			return await this.#withDialogTurn(() => this.#popFileIntoDialog(surfaceId));
		} finally {
			this.#reservedSurfaceIds.delete(surfaceId);
		}
	}

	async moveDialogFileToHost(destination: HostId): Promise<void> {
		await this.#withDialogTurn(async () => {
			if (this.isMobile) return;
			const surfaceId = this.layout.snapshot.dialogFileSurfaceId;
			if (!surfaceId || this.#reservedSurfaceIds.has(surfaceId)) return;
			this.#reservedSurfaceIds.add(surfaceId);
			try {
				const current = await this.#commit((latest) => {
					if (latest.dialogFileSurfaceId !== surfaceId) {
						throw new Error('The dialog occupant changed before it could be moved');
					}
					return [{ type: 'move-dialog-to-host', surfaceId, destination }];
				});
				if (!current) return;
				this.lastFocusedSurfaceId = surfaceId;
				this.#dialogReturnSurfaceId = null;
				this.#focusPresentedSurface(surfaceId);
			} finally {
				this.#reservedSurfaceIds.delete(surfaceId);
			}
		});
	}

	async createTerminal(host: HostId = 'main'): Promise<string> {
		if (host === 'main' && this.isChatPresented) {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		}
		const terminalId = await this.#createTerminalWithRequestId(crypto.randomUUID());
		const surfaceId = terminalSurfaceId(terminalId);
		if (!this.layout.surface(surfaceId)) {
			const mutations: WorkspaceLayoutMutation[] = [
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'terminal', terminalId },
					host,
				},
				{ type: 'focus-host', host, surfaceId },
			];
			if (this.isMobile) {
				mutations.push({
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack: this.layout.snapshot.mobileReturnStack,
				});
			}
			const current = await this.#commit(mutations);
			if (!current) return terminalId;
		} else {
			await this.focusSurface(surfaceId);
		}
		this.lastFocusedSurfaceId = surfaceId;
		if (this.isMobile) this.#noteMobileActivation(surfaceId);
		this.#focusPresentedSurface(surfaceId);
		return terminalId;
	}

	async openTerminalSession(terminalId: string, preferredHost: HostId = 'main'): Promise<void> {
		if (!this.#deps.terminals.sessions[terminalId]) return;
		const surfaceId = terminalSurfaceId(terminalId);
		if (this.layout.surface(surfaceId)) {
			await this.focusSurface(surfaceId);
			return;
		}
		const mutations: WorkspaceLayoutMutation[] = [
			{
				type: 'register-surface',
				surface: { id: surfaceId, type: 'terminal', terminalId },
				host: preferredHost,
			},
			{ type: 'focus-host', host: preferredHost, surfaceId },
		];
		if (this.isMobile) {
			mutations.push({
				type: 'set-mobile-presentation',
				activeId: surfaceId,
				returnStack: this.layout.snapshot.mobileReturnStack,
			});
		}
		const current = await this.#commit(mutations);
		if (!current) return;
		this.lastFocusedSurfaceId = surfaceId;
		if (this.isMobile) this.#noteMobileActivation(surfaceId);
		this.#focusPresentedSurface(surfaceId);
	}

	async focusMostRecentTerminalOrCreate(preferredHost: HostId = 'main'): Promise<void> {
		const focused = this.layout.surface(this.lastFocusedSurfaceId);
		if (focused?.type === 'terminal' && this.#deps.terminals.sessions[focused.terminalId]) {
			await this.openTerminalSession(focused.terminalId, preferredHost);
			return;
		}
		let terminal = this.#deps.terminals.orderedSessions.at(-1);
		if (!terminal && this.#deps.terminals.listStatus !== 'ready') {
			await this.#deps.terminals.list();
			terminal = this.#deps.terminals.orderedSessions.at(-1);
		}
		if (terminal) {
			await this.openTerminalSession(terminal.metadata.terminalId, preferredHost);
			return;
		}
		if (
			this.#deps.terminals.listStatus === 'ready' &&
			this.#deps.terminals.orderedSessions.length < TERMINAL_SESSION_LIMIT
		)
			await this.createTerminal(preferredHost);
	}

	async openSidebar(): Promise<void> {
		const commit = () =>
			this.#commit((latest) => {
				const mutations: WorkspaceLayoutMutation[] = [{ type: 'set-sidebar-open', open: true }];
				if (latest.sidebar.order.length === 0 && !latest.surfaces['singleton:files']) {
					mutations.push(
						{ type: 'register-surface', surface: singletonDescriptor('files'), host: 'sidebar' },
						{ type: 'focus-host', host: 'sidebar', surfaceId: 'singleton:files' },
					);
				}
				return mutations;
			});
		const current = this.#sidebarOverlayMode
			? await this.#deps.transientLayers.open('main-inert', commit)
			: await commit();
		if (!current) return;
		if (this.activeSidebarId) {
			this.lastFocusedSurfaceId = this.activeSidebarId;
			this.#focusPresentedSurface(this.activeSidebarId);
		}
	}

	setSidebarOverlayMode(overlay: boolean): void {
		this.#sidebarOverlayMode = overlay;
	}

	async closeSidebar(): Promise<void> {
		const current = await this.#commit([{ type: 'set-sidebar-open', open: false }]);
		if (!current) return;
		this.lastFocusedSurfaceId = this.activeMainId;
		this.#focusPresentedSurface(this.activeMainId);
	}

	async enterMobilePresentation(): Promise<void> {
		if (this.#presentationMode === 'mobile') return;
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		const responsiveGeneration = ++this.#responsiveGeneration;
		const from = this.#presentationMode;
		this.#presentationMode = 'mobile';
		const activeId = selectMobileEntrySurface(this.layout.snapshot, this.lastFocusedSurfaceId);
		let current: boolean;
		try {
			current = await this.#commit(
				[
					{
						type: 'set-mobile-presentation',
						activeId,
						returnStack: this.layout.snapshot.mobileReturnStack,
					},
				],
				undefined,
				{ from, to: 'mobile' },
			);
		} catch (error) {
			if (
				responsiveGeneration === this.#responsiveGeneration &&
				this.#presentationMode === 'mobile'
			) {
				this.#presentationMode = from;
			}
			throw error;
		}
		if (!current) return;
		this.lastFocusedSurfaceId = activeId;
		this.#noteMobileActivation(activeId);
		this.#focusPresentedSurface(activeId);
	}

	async exitMobilePresentation(): Promise<void> {
		if (this.#presentationMode === 'desktop') return;
		const responsiveGeneration = ++this.#responsiveGeneration;
		const from = this.#presentationMode;
		this.#presentationMode = 'desktop';
		const mutations = planDesktopReturnMutations(this.layout.snapshot, this.#mobileMruSurfaceIds);
		let current: boolean;
		try {
			current = await this.#commit(mutations, undefined, { from, to: 'desktop' });
		} catch (error) {
			if (
				responsiveGeneration === this.#responsiveGeneration &&
				this.#presentationMode === 'desktop'
			) {
				this.#presentationMode = from;
			}
			throw error;
		}
		if (!current) return;
		this.#focusPresentedSurface(this.lastFocusedSurfaceId);
	}

	async focusMobileSingleton(kind: PortableSingletonKind): Promise<void> {
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		const surfaceId = singletonSurfaceId(kind);
		if (!this.layout.surface(surfaceId)) {
			await this.#commit([{ type: 'register-surface', surface: singletonDescriptor(kind) }]);
		}
		const current = await this.#commit([
			{
				type: 'set-mobile-presentation',
				activeId: surfaceId,
				returnStack:
					kind === 'quick-git'
						? this.#returnStackForTransient(surfaceId)
						: this.layout.snapshot.mobileReturnStack,
			},
		]);
		if (!current) return;
		this.lastFocusedSurfaceId = surfaceId;
		this.#noteMobileActivation(surfaceId);
		this.#focusPresentedSurface(surfaceId);
	}

	async mobileBack(): Promise<void> {
		if (!this.isMobile) return;
		const currentId = this.layout.snapshot.mobileActiveSurfaceId;
		const fallback = this.#resolveMobileReturn(currentId);
		const current = await this.#commit([
			{
				type: 'set-mobile-presentation',
				activeId: fallback.activeId,
				returnStack: fallback.returnStack,
			},
		]);
		if (!current) return;
		this.lastFocusedSurfaceId = fallback.activeId;
		this.#noteMobileActivation(fallback.activeId);
		this.#focusPresentedSurface(fallback.activeId);
	}

	async setSidebarWidth(width: number): Promise<void> {
		await this.#commit([{ type: 'set-sidebar-width', width }]);
	}

	async setManualFullscreen(enabled: boolean): Promise<void> {
		const current = await this.#commit([{ type: 'set-manual-fullscreen', enabled }]);
		if (!current) return;
		if (enabled) {
			this.lastFocusedSurfaceId = this.activeMainId;
			this.#focusPresentedSurface(this.activeMainId);
		}
	}

	async retryPresentation(surfaceId: string, host: PresentationHostId): Promise<void> {
		const frames = this.#deps.surfaceFrames;
		if (!frames || !this.layout.surface(surfaceId)) return;
		const generation = ++this.#presentationGeneration;
		const expectation = frames.beginTransfer(surfaceId, host);
		this.#bumpFrameVersion(surfaceId);
		await this.#settleFrame(expectation);
		if (generation !== this.#presentationGeneration) return;
		this.#focusPresentedSurface(surfaceId);
	}

	async reconcileTerminals(
		liveTerminalIds: readonly string[],
		options: { deriveLauncher: boolean },
	): Promise<void> {
		const live = new Set(liveTerminalIds);
		for (const terminalId of this.#terminalTerminateRequestIds.keys()) {
			if (!live.has(terminalId)) this.#terminalTerminateRequestIds.delete(terminalId);
		}
		await this.#commit((latest) => {
			const mutations: WorkspaceLayoutMutation[] = [];
			for (const surface of Object.values(latest.surfaces)) {
				if (surface.type === 'terminal' && !live.has(surface.terminalId)) {
					mutations.push({ type: 'remove-surface', surfaceId: surface.id });
				}
			}
			const launcher = latest.surfaces['terminal-launcher'];
			if (live.size > 0 && launcher && !this.#reservedSurfaceIds.has(launcher.id)) {
				mutations.push({ type: 'remove-surface', surfaceId: launcher.id });
			} else if (
				live.size === 0 &&
				options.deriveLauncher &&
				!launcher &&
				this.#isCanonicalFirstRunLayout(latest)
			) {
				mutations.push({
					type: 'register-surface',
					surface: { id: 'terminal-launcher', type: 'terminal-launcher' },
					host: 'main',
				});
			}
			return mutations;
		});
	}

	async omitCanonicalPullRequests(): Promise<void> {
		const snapshot = this.layout.snapshot;
		if (snapshot.main.activeId === 'singleton:pull-requests') return;
		const mainWithoutLauncher = snapshot.main.order.filter((id) => id !== 'terminal-launcher');
		if (
			mainWithoutLauncher.length !== 3 ||
			mainWithoutLauncher[0] !== CHAT_SURFACE_ID ||
			mainWithoutLauncher[1] !== 'singleton:git' ||
			mainWithoutLauncher[2] !== 'singleton:pull-requests' ||
			snapshot.sidebar.order.length !== 2 ||
			snapshot.sidebar.order[0] !== 'singleton:files' ||
			snapshot.sidebar.order[1] !== 'singleton:quick-git'
		)
			return;
		await this.#commit([{ type: 'remove-surface', surfaceId: 'singleton:pull-requests' }]);
	}

	async activateTerminalLauncher(host: HostId): Promise<void> {
		const launcherId = 'terminal-launcher';
		if (!this.layout.surface(launcherId) || this.#reservedSurfaceIds.has(launcherId)) return;
		this.#reservedSurfaceIds.add(launcherId);
		try {
			const terminalId = await this.#retryTerminalCreate(`launcher:${host}`);
			const surfaceId = terminalSurfaceId(terminalId);
			const current = await this.#commit([
				{
					type: 'replace-surface',
					previousId: launcherId,
					surface: { id: surfaceId, type: 'terminal', terminalId },
				},
				{ type: 'focus-host', host, surfaceId },
			]);
			if (!current) return;
			this.lastFocusedSurfaceId = surfaceId;
			this.#focusPresentedSurface(surfaceId);
		} finally {
			this.#reservedSurfaceIds.delete(launcherId);
		}
	}

	#hostOf(surfaceId: string): HostId | null {
		return this.#hostOfSnapshot(this.layout.snapshot, surfaceId);
	}

	#isSurfacePresented(surfaceId: string): boolean {
		return [...this.#visiblePresentations(this.layout.snapshot).values()].includes(surfaceId);
	}

	async #retryTerminalCreate(requestKey: string): Promise<string> {
		let requestId = this.#terminalCreateRequestIds.get(requestKey);
		if (requestId && !this.#deps.terminals.pendingCreates[requestId]) {
			this.#terminalCreateRequestIds.delete(requestKey);
			requestId = undefined;
		}
		requestId ??= crypto.randomUUID();
		this.#terminalCreateRequestIds.set(requestKey, requestId);
		try {
			return await this.#createTerminalWithRequestId(requestId);
		} finally {
			if (!this.#deps.terminals.pendingCreates[requestId]) {
				this.#terminalCreateRequestIds.delete(requestKey);
			}
		}
	}

	#createTerminalWithRequestId(requestId: string): Promise<string> {
		return this.#deps.terminals.create(
			this.#deps.workspaceContext.current?.projectPath ?? null,
			requestId,
		);
	}

	async #requestTerminalTermination(terminalId: string): Promise<void> {
		let requestId = this.#terminalTerminateRequestIds.get(terminalId);
		if (!requestId) {
			requestId = crypto.randomUUID();
			this.#terminalTerminateRequestIds.set(terminalId, requestId);
		}
		await this.#deps.terminals.requestTermination(terminalId, requestId);
	}

	#isCanonicalFirstRunLayout(snapshot: WorkspaceLayoutSnapshot): boolean {
		const expectedMain = snapshot.surfaces['singleton:pull-requests']
			? [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests']
			: [CHAT_SURFACE_ID, 'singleton:git'];
		return (
			snapshot.main.activeId === CHAT_SURFACE_ID &&
			snapshot.main.order.length === expectedMain.length &&
			snapshot.main.order.every((surfaceId, index) => surfaceId === expectedMain[index]) &&
			snapshot.sidebar.order.length === 2 &&
			snapshot.sidebar.order[0] === 'singleton:files' &&
			snapshot.sidebar.order[1] === 'singleton:quick-git' &&
			!snapshot.sidebarOpen &&
			!snapshot.dialogFileSurfaceId &&
			snapshot.mobileOnlySurfaceIds.length === 0
		);
	}

	#hostOfSnapshot(snapshot: WorkspaceLayoutSnapshot, surfaceId: string): HostId | null {
		if (snapshot.main.order.includes(surfaceId)) return 'main';
		if (snapshot.sidebar.order.includes(surfaceId)) return 'sidebar';
		return null;
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
		const host = this.#presentationHostOf(surfaceId);
		if (host) this.#deps.surfaceFrames?.focus(surfaceId, host);
	}

	#eligibleDesktopReturn(surfaceId: string | null): string | null {
		if (!surfaceId || !this.layout.surface(surfaceId)) return null;
		const snapshot = this.layout.snapshot;
		if (snapshot.main.order.includes(surfaceId)) return surfaceId;
		if (snapshot.sidebarOpen && snapshot.sidebar.order.includes(surfaceId)) return surfaceId;
		return null;
	}

	#returnStackForTransient(nextSurfaceId: string): readonly MobileReturnTarget[] {
		const snapshot = this.layout.snapshot;
		if (!this.isMobile || snapshot.mobileActiveSurfaceId === nextSurfaceId) {
			return snapshot.mobileReturnStack;
		}
		const context = this.#deps.workspaceContext.current;
		return [
			...snapshot.mobileReturnStack,
			{
				invokerSurfaceId: snapshot.mobileActiveSurfaceId,
				invokerHost: 'mobile' as const,
				chatId: context?.chatId ?? null,
				effectiveProjectKey: context?.effectiveProjectKey ?? null,
				routeIdentity: this.#deps.getRouteIdentity(),
			},
		];
	}

	#resolveMobileReturn(excludingSurfaceId: string): {
		activeId: string;
		returnStack: readonly MobileReturnTarget[];
	} {
		const snapshot = this.layout.snapshot;
		const context = this.#deps.workspaceContext.current;
		const routeIdentity = this.#deps.getRouteIdentity();
		for (let index = snapshot.mobileReturnStack.length - 1; index >= 0; index -= 1) {
			const target = snapshot.mobileReturnStack[index];
			if (
				target.invokerSurfaceId !== excludingSurfaceId &&
				snapshot.surfaces[target.invokerSurfaceId] &&
				target.routeIdentity === routeIdentity &&
				target.chatId === (context?.chatId ?? null) &&
				target.effectiveProjectKey === (context?.effectiveProjectKey ?? null)
			) {
				return {
					activeId: target.invokerSurfaceId,
					returnStack: snapshot.mobileReturnStack.slice(0, index),
				};
			}
		}
		const mru = this.#mobileMruSurfaceIds.find(
			(id) => id !== excludingSurfaceId && Boolean(snapshot.surfaces[id]),
		);
		return {
			activeId: mru ?? snapshot.main.activeId ?? CHAT_SURFACE_ID,
			returnStack: [],
		};
	}

	#noteMobileActivation(surfaceId: string): void {
		this.#mobileMruSurfaceIds = [
			surfaceId,
			...this.#mobileMruSurfaceIds.filter((id) => id !== surfaceId),
		];
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

	async #placeNewFileInDialog(
		sessionId: string,
		surfaceId: string,
		publication?: { publish(): void; rollback(): void },
	): Promise<boolean> {
		if (this.isMobile) {
			return this.#placeFileSessionOnMobile(sessionId, surfaceId, publication);
		}
		const responsiveGeneration = this.#responsiveGeneration;
		const returnSurfaceId =
			this.#eligibleDesktopReturn(this.lastFocusedSurfaceId) ?? this.activeMainId;
		const occupantId = this.layout.snapshot.dialogFileSurfaceId;
		let occupantSessionId: string | null = null;
		if (occupantId) {
			const occupant = this.layout.surface(occupantId);
			if (occupant?.type === 'file') {
				this.#reservedSurfaceIds.add(occupantId);
				const canReplace = await this.#deps.files.confirmDestructive(
					occupant.fileSessionId,
					'replace-dialog',
				);
				if (!canReplace) {
					this.#reservedSurfaceIds.delete(occupantId);
					return false;
				}
				if (responsiveGeneration !== this.#responsiveGeneration) {
					this.#reservedSurfaceIds.delete(occupantId);
					return false;
				}
				occupantSessionId = occupant.fileSessionId;
			}
		}
		try {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
			const current = await this.#commit((latest) => {
				if (latest.dialogFileSurfaceId !== occupantId) {
					throw new Error('The dialog occupant changed before replacement');
				}
				const mutations: WorkspaceLayoutMutation[] = [];
				if (occupantId) mutations.push({ type: 'remove-surface', surfaceId: occupantId });
				mutations.push(
					{
						type: 'register-surface',
						surface: { id: surfaceId, type: 'file', fileSessionId: sessionId },
					},
					{ type: 'place-in-dialog', surfaceId },
				);
				return mutations;
			}, publication);
			if (occupantSessionId) this.#deps.files.destroy(occupantSessionId);
			if (!current) return true;
			this.#dialogReturnSurfaceId = returnSurfaceId;
			this.lastFocusedSurfaceId = surfaceId;
			this.#focusPresentedSurface(surfaceId);
			return true;
		} finally {
			if (occupantId) this.#reservedSurfaceIds.delete(occupantId);
		}
	}

	async #popFileIntoDialog(surfaceId: string): Promise<boolean> {
		if (this.isMobile) return false;
		const responsiveGeneration = this.#responsiveGeneration;
		const sourceHost = this.#hostOf(surfaceId);
		const occupantId = this.layout.snapshot.dialogFileSurfaceId;
		if (occupantId === surfaceId) return true;
		let occupantSessionId: string | null = null;
		if (occupantId) {
			const occupant = this.layout.surface(occupantId);
			if (occupant?.type === 'file') {
				this.#reservedSurfaceIds.add(occupantId);
				const canReplace = await this.#deps.files.confirmDestructive(
					occupant.fileSessionId,
					'replace-dialog',
				);
				if (!canReplace) {
					this.#reservedSurfaceIds.delete(occupantId);
					return false;
				}
				if (responsiveGeneration !== this.#responsiveGeneration) {
					this.#reservedSurfaceIds.delete(occupantId);
					return false;
				}
				occupantSessionId = occupant.fileSessionId;
			}
		}
		try {
			this.#deps.chatInteractionGate.cancelBeforeInertTransition();
			const current = await this.#commit((latest) => {
				if (latest.dialogFileSurfaceId !== occupantId) {
					throw new Error('The dialog occupant changed before pop out');
				}
				const mutations: WorkspaceLayoutMutation[] = [];
				if (occupantId && occupantId !== surfaceId) {
					mutations.push({ type: 'remove-surface', surfaceId: occupantId });
				}
				mutations.push({ type: 'place-in-dialog', surfaceId });
				return mutations;
			});
			if (occupantSessionId) this.#deps.files.destroy(occupantSessionId);
			if (!current) return true;
			this.#dialogReturnSurfaceId =
				sourceHost === 'sidebar' && this.layout.snapshot.sidebarOpen
					? this.activeSidebarId
					: this.activeMainId;
			this.lastFocusedSurfaceId = surfaceId;
			this.#focusPresentedSurface(surfaceId);
			return true;
		} finally {
			if (occupantId) this.#reservedSurfaceIds.delete(occupantId);
		}
	}

	async #placeFileSessionOnMobile(
		sessionId: string,
		surfaceId: string,
		publication?: { publish(): void; rollback(): void },
	): Promise<boolean> {
		this.#deps.chatInteractionGate.cancelBeforeInertTransition();
		const returnStack = this.#returnStackForTransient(surfaceId);
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
			publication,
		);
		if (!current) return true;
		this.lastFocusedSurfaceId = surfaceId;
		this.#noteMobileActivation(surfaceId);
		this.#focusPresentedSurface(surfaceId);
		return true;
	}

	#withDialogTurn<T>(operation: () => Promise<T>): Promise<T> {
		let resolveResult: (value: T | PromiseLike<T>) => void;
		let rejectResult: (reason?: unknown) => void;
		const result = new Promise<T>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const turn = this.#dialogTail.then(operation);
		this.#dialogTail = turn.then(
			() => undefined,
			() => undefined,
		);
		void turn.then(resolveResult!, rejectResult!);
		return result;
	}

	async #commit(
		mutations: import('./workspace-transition-arbiter.js').WorkspaceMutationPlan,
		publication?: { publish(): void; rollback(): void },
		presentationModes?: {
			from: 'desktop' | 'mobile';
			to: 'desktop' | 'mobile';
		},
		options: { guaranteedRemoval?: boolean } = {},
	): Promise<boolean> {
		let expectations: FrameExpectation[] = [];
		let presentationGeneration: number | null = null;
		const published = await this.#deps.arbiter.commit(
			mutations,
			{
				beforePublish: (next, base) => {
				this.#deps.chatInteractionGate.setPresented(
					this.#isChatPresentedInSnapshot(next, presentationModes?.to),
				);
				this.#hideLeavingSingletons(
					base,
					next,
					presentationModes?.from,
					presentationModes?.to,
				);
					publication?.publish();
					if (
						this.#presentationsChanged(base, next, presentationModes?.from, presentationModes?.to)
					) {
						presentationGeneration = ++this.#presentationGeneration;
					}
					try {
						expectations = this.#prepareFrames(
							base,
							next,
							presentationModes?.from,
							presentationModes?.to,
						);
					} catch (error) {
						if (!options.guaranteedRemoval) throw error;
						expectations = [];
						this.#recordPreparationError(next, error, presentationModes?.to);
					}
				},
				publishFailed: () => {
					this.#deps.chatInteractionGate.setPresented(
						this.#isChatPresentedInSnapshot(this.layout.snapshot, presentationModes?.from),
					);
					this.#syncSingletonVisibility(this.layout.snapshot, presentationModes?.from);
					publication?.rollback();
					for (const expectation of expectations) {
						this.#deps.surfaceFrames?.cancel(expectation.surfaceId);
					}
				},
			},
			{ retryPublishFailure: options.guaranteedRemoval },
		);
		if (!published) throw new Error('Workspace layout changed before the action committed');
		this.#syncSingletonVisibility(this.layout.snapshot, presentationModes?.to);
		try {
			this.#deps.onLayoutChanged?.(this.layout.snapshot);
		} catch (error) {
			if (!options.guaranteedRemoval) throw error;
			console.error('Failed to persist workspace layout after destructive removal', error);
		}
		await Promise.all(expectations.map((expectation) => this.#settleFrame(expectation)));
		return (
			presentationGeneration === null || presentationGeneration === this.#presentationGeneration
		);
	}

	#recordPreparationError(
		snapshot: WorkspaceLayoutSnapshot,
		error: unknown,
		mode: 'desktop' | 'mobile' = this.#presentationMode,
	): void {
		const message = error instanceof Error ? error.message : m.workspace_surface_attach_failed();
		const nextErrors = { ...this.attachmentErrors };
		for (const surfaceId of this.#visiblePresentations(snapshot, mode).values()) {
			if (surfaceId !== CHAT_SURFACE_ID) nextErrors[surfaceId] = message;
		}
		this.attachmentErrors = nextErrors;
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
		for (const kind of ['git', 'pull-requests', 'files', 'quick-git'] as const) {
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
		for (const kind of ['git', 'pull-requests', 'files', 'quick-git'] as const) {
			const surfaceId = singletonSurfaceId(kind);
			if (before.has(surfaceId) && !after.has(surfaceId)) {
				this.#deps.singletons.setPresentationVisible(kind, false);
			}
		}
	}

	#presentationsChanged(
		base: WorkspaceLayoutSnapshot,
		next: WorkspaceLayoutSnapshot,
		fromMode: 'desktop' | 'mobile' = this.#presentationMode,
		toMode: 'desktop' | 'mobile' = this.#presentationMode,
	): boolean {
		const before = this.#visiblePresentations(base, fromMode);
		const after = this.#visiblePresentations(next, toMode);
		if (before.size !== after.size) return true;
		for (const [host, surfaceId] of before) {
			if (after.get(host) !== surfaceId) return true;
		}
		return false;
	}

	#prepareFrames(
		base: WorkspaceLayoutSnapshot,
		next: WorkspaceLayoutSnapshot,
		fromMode: 'desktop' | 'mobile' = this.#presentationMode,
		toMode: 'desktop' | 'mobile' = this.#presentationMode,
	): FrameExpectation[] {
		const frames = this.#deps.surfaceFrames;
		if (!frames) return [];
		const before = this.#visiblePresentations(base, fromMode);
		const after = this.#visiblePresentations(next, toMode);
		for (const [host, surfaceId] of before) {
			if (after.get(host) === surfaceId) continue;
			this.#prepareRetainedRenderer(surfaceId, base);
		}
		const afterSurfaceIds = new Set(after.values());
		for (const surfaceId of before.values()) {
			if (!afterSurfaceIds.has(surfaceId)) frames.cancel(surfaceId);
		}
		const expectations: FrameExpectation[] = [];
		for (const [host, surfaceId] of after) {
			if (surfaceId === CHAT_SURFACE_ID || before.get(host) === surfaceId) continue;
			expectations.push(frames.beginTransfer(surfaceId, host));
			this.#bumpFrameVersion(surfaceId);
		}
		return expectations;
	}

	#prepareRetainedRenderer(surfaceId: string, snapshot: WorkspaceLayoutSnapshot): void {
		const surface = snapshot.surfaces[surfaceId];
		if (surface?.type === 'terminal') {
			this.#deps.terminals.prepareRendererTransfer(surface.terminalId);
			return;
		}
		if (surface?.type === 'file') {
			this.#deps.files.get(surface.fileSessionId)?.editor?.prepareRendererTransfer();
		}
	}

	#visiblePresentations(
		snapshot: WorkspaceLayoutSnapshot,
		mode: 'desktop' | 'mobile' = this.#presentationMode,
	): Map<PresentationHostId, string> {
		const visible = new Map<PresentationHostId, string>();
		if (mode === 'mobile') {
			visible.set('mobile', snapshot.mobileActiveSurfaceId);
			return visible;
		}
		if (snapshot.main.activeId) visible.set('main', snapshot.main.activeId);
		if (snapshot.sidebarOpen && !snapshot.manualFullscreen && snapshot.sidebar.activeId) {
			visible.set('sidebar', snapshot.sidebar.activeId);
		}
		if (snapshot.dialogFileSurfaceId) visible.set('dialog', snapshot.dialogFileSurfaceId);
		return visible;
	}

	#bumpFrameVersion(surfaceId: string): void {
		this.frameVersions = {
			...this.frameVersions,
			[surfaceId]: (this.frameVersions[surfaceId] ?? 0) + 1,
		};
	}

	#clearAttachmentError(surfaceId: string): void {
		const { [surfaceId]: _removed, ...remaining } = this.attachmentErrors;
		this.attachmentErrors = remaining;
	}

	async #settleFrame(expectation: FrameExpectation): Promise<void> {
		const frames = this.#deps.surfaceFrames;
		if (!frames) return;
		try {
			const handle = await frames.waitFor(expectation);
			await handle.attachRetainedRenderer();
			this.#clearAttachmentError(expectation.surfaceId);
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return;
			this.attachmentErrors = {
				...this.attachmentErrors,
				[expectation.surfaceId]:
					error instanceof Error ? error.message : m.workspace_surface_attach_failed(),
			};
		}
	}
}
