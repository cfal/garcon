import * as m from '$lib/paraglide/messages.js';
import type { TerminalRegistry } from '$lib/stores/terminal-registry.svelte.js';
import { createRandomId } from '$lib/utils/random-id.js';
import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
import {
	terminalSurfaceId,
	type HostId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutReader,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';
import type { WorkspaceCommit } from './workspace-commit.js';
import type { WorkspaceMutationPlan } from './workspace-transition-arbiter.js';

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
	commit: WorkspaceCommit;
	commitDestroyedRemoval(surfaceId: string, mutations: WorkspaceMutationPlan): Promise<boolean>;
	currentProjectPath(): string | null;
	isMobile(): boolean;
	isChatPresented(): boolean;
	cancelChatTransition(): void;
	hostOf(surfaceId: string): HostId | null;
	activeMainId(): string;
	activeSidebarId(): string | null;
	lastFocusedSurfaceId(): string;
	focusSurface(surfaceId: string): Promise<void>;
	present(surfaceId: string): void;
	resolveMobileReturn(
		excluding: string | ReadonlySet<string>,
		snapshot?: WorkspaceLayoutSnapshot,
	): MobileReturnPlan;
	confirmClose(request: TerminalCloseGuardRequest): Promise<boolean>;
	clearAttachmentError(surfaceId: string): void;
	isCanonicalFirstRunLayout(snapshot: WorkspaceLayoutSnapshot): boolean;
}

export class TerminalPlacementService {
	#terminalCreateRequestIds = new Map<string, string>();
	#terminalTerminateRequestIds = new Map<string, string>();
	#pendingTerminatedTerminalIds = new Set<string>();

	constructor(private readonly deps: TerminalPlacementServiceDeps) {}

	async create(host: HostId = 'main', requestKey?: string): Promise<string> {
		if (host === 'main' && this.deps.isChatPresented()) {
			this.deps.cancelChatTransition();
		}
		const terminalId = requestKey
			? await this.#retryCreate(requestKey)
			: await this.#createWithRequestId(createRandomId());
		const surfaceId = terminalSurfaceId(terminalId);
		if (!this.deps.layout.surface(surfaceId)) {
			const mutations: WorkspaceLayoutMutation[] = [
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'terminal', terminalId },
					host,
				},
				{ type: 'focus-host', host, surfaceId },
			];
			if (this.deps.isMobile()) {
				mutations.push({
					type: 'set-mobile-presentation',
					activeId: surfaceId,
					returnStack: this.deps.layout.snapshot.mobileReturnStack,
				});
			}
			let current = false;
			try {
				current = await this.deps.commit(mutations, { requiredPublication: true });
			} catch (error) {
				await this.#rollbackUnplaced(terminalId, error);
			}
			if (!current) return terminalId;
		} else {
			await this.deps.focusSurface(surfaceId);
		}
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

	async open(terminalId: string, preferredHost: HostId = 'main'): Promise<void> {
		if (!this.deps.terminals.sessions[terminalId]) return;
		const surfaceId = terminalSurfaceId(terminalId);
		if (this.deps.layout.surface(surfaceId)) {
			await this.deps.focusSurface(surfaceId);
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
		if (this.deps.isMobile()) {
			mutations.push({
				type: 'set-mobile-presentation',
				activeId: surfaceId,
				returnStack: this.deps.layout.snapshot.mobileReturnStack,
			});
		}
		const current = await this.deps.commit(mutations);
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
					title: m.terminal_terminate_title({ number: session.metadata.displaySequence }),
					description: m.terminal_terminate_description(),
					confirmLabel: m.terminal_terminate(),
				}))
			) {
				return false;
			}
			if (!this.#pendingTerminatedTerminalIds.has(terminalId)) {
				await this.#requestTermination(terminalId);
			}
			this.#terminalTerminateRequestIds.delete(terminalId);
			this.deps.terminals.disposeTerminatedSession(terminalId);
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
			const sourceHost = this.deps.hostOf(surfaceId);
			let mobileFallbackId: string | null = null;
			const current = await this.deps.commitDestroyedRemoval(surfaceId, (latest) => {
				if (!latest.surfaces[surfaceId]) return [];
				const mutations: WorkspaceLayoutMutation[] = [{ type: 'forget-terminal', terminalId }];
				if (this.deps.isMobile() && latest.mobileActiveSurfaceId === surfaceId) {
					const fallback = this.deps.resolveMobileReturn(surfaceId, latest);
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
			const fallbackSurfaceId =
				mobileFallbackId ??
				(sourceHost === 'sidebar' && this.deps.layout.snapshot.sidebarOpen
					? this.deps.activeSidebarId()
					: this.deps.activeMainId()) ??
				this.deps.activeMainId();
			this.deps.present(fallbackSurfaceId);
		} finally {
			this.deps.reservations.delete(surfaceId);
		}
	}

	async afterPlacementReleased(terminalId: string): Promise<void> {
		if (this.#pendingTerminatedTerminalIds.delete(terminalId)) {
			await this.handleTerminated(terminalId);
		}
	}

	async focusMostRecentOrCreate(preferredHost: HostId = 'main'): Promise<void> {
		const focused = this.deps.layout.surface(this.deps.lastFocusedSurfaceId());
		if (focused?.type === 'terminal' && this.deps.terminals.sessions[focused.terminalId]) {
			await this.open(focused.terminalId, preferredHost);
			return;
		}
		let terminal = this.deps.terminals.orderedSessions.at(-1);
		if (!terminal && this.deps.terminals.listStatus !== 'ready') {
			await this.deps.terminals.list();
			terminal = this.deps.terminals.orderedSessions.at(-1);
		}
		if (terminal) {
			await this.open(terminal.metadata.terminalId, preferredHost);
			return;
		}
		if (
			this.deps.terminals.listStatus === 'ready' &&
			this.deps.terminals.orderedSessions.length < TERMINAL_SESSION_LIMIT
		) {
			await this.create(preferredHost, `terminal-empty-state:${preferredHost}`);
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
			const launcher = latest.surfaces['terminal-launcher'];
			const launcherReserved = Boolean(launcher && this.deps.reservations.has(launcher.id));
			if (live.size > 0 && launcher && !launcherReserved) {
				mutations.push({ type: 'remove-surface', surfaceId: launcher.id });
				removedSurfaceIds.add(launcher.id);
			} else if (
				live.size === 0 &&
				options.deriveLauncher &&
				!launcher &&
				this.deps.isCanonicalFirstRunLayout(latest)
			) {
				mutations.push({
					type: 'register-surface',
					surface: { id: 'terminal-launcher', type: 'terminal-launcher' },
					host: 'main',
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
						host: 'main',
					});
				}
			} else {
				for (const terminalId of unrepresentedTerminalIds) {
					mutations.push({ type: 'unplace-terminal', terminalId });
				}
			}
			if (this.deps.isMobile() && removedSurfaceIds.has(latest.mobileActiveSurfaceId)) {
				const fallback = this.deps.resolveMobileReturn(removedSurfaceIds, latest);
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

	async activateLauncher(host: HostId): Promise<void> {
		const launcherId = 'terminal-launcher';
		if (!this.deps.layout.surface(launcherId) || this.deps.reservations.has(launcherId)) {
			return;
		}
		this.deps.reservations.add(launcherId);
		try {
			const terminalId = await this.#retryCreate(`launcher:${host}`);
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
						{ type: 'focus-host', host, surfaceId },
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
