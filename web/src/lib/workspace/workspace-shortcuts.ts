import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { NavigationStore } from '$lib/stores/navigation.svelte.js';
import type { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';
import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import type { FocusOwner } from './surface-types.js';
import {
	getEffectiveGlobalShortcut,
	globalShortcutMatchesEvent,
	type GlobalShortcutId,
} from './global-shortcuts.js';
import {
	closestWorkspaceScrollRegion,
	scrollWorkspaceRegion,
	WORKSPACE_SCROLL_REGION_SELECTOR,
	workspaceScrollRegionRole,
	type WorkspaceHalfPageDirection,
} from './workspace-scroll-region.js';

export type WorkspaceSurfaceShortcutHandler = (event: KeyboardEvent) => boolean;
export type WorkspaceLocalShortcutOwner = (event: KeyboardEvent) => boolean;
type WorkspaceScrollInteraction = 'focus' | 'pointer' | 'wheel';

export interface WorkspaceShortcutDeps {
	workspace: Pick<
		WorkspaceCoordinator,
		| 'focusOwner'
		| 'isSurfacePresented'
		| 'focusPreviousTabInFocusedWindow'
		| 'focusNextTabInFocusedWindow'
		| 'cycleWindowFocus'
	> & { layout: Pick<WorkspaceCoordinator['layout'], 'surface'> };
	transients: Pick<
		TransientLayerRegistry,
		'makesMainInert' | 'handleEscape' | 'ownsTopModalTarget'
	>;
	appShell: Pick<
		AppShellStore,
		| 'openSettings'
		| 'requestNewChat'
		| 'openSidebarSearch'
		| 'requestDeleteSelectedChat'
		| 'requestRenameSelectedChat'
	>;
	navigation: Pick<NavigationStore, 'requestNavigateChatAbove' | 'requestNavigateChatBelow'>;
	files: Pick<FileSessionRegistry, 'save'>;
	localSettings: Pick<LocalSettingsStore, 'globalShortcuts'>;
}

export class WorkspaceShortcutDispatcher {
	readonly #handlers = new Map<string, Set<WorkspaceSurfaceShortcutHandler>>();
	readonly #localOwners = new Map<HTMLElement, Set<WorkspaceLocalShortcutOwner>>();
	#toggleCommandMenu: (() => void) | null = null;
	#userInteractionGeneration = 0;
	#lastInteractedScrollRegion: HTMLElement | null = null;
	#pendingPointerFocus: { region: HTMLElement } | null = null;

	constructor(private readonly deps: WorkspaceShortcutDeps) {}

	setCommandMenuHandler(handler: (() => void) | null): void {
		this.#toggleCommandMenu = handler;
	}

	get userInteractionGeneration(): number {
		return this.#userInteractionGeneration;
	}

	noteUserInteraction(): void {
		this.#userInteractionGeneration += 1;
	}

	registerSurface(surfaceId: string, handler: WorkspaceSurfaceShortcutHandler): () => void {
		let handlers = this.#handlers.get(surfaceId);
		if (!handlers) {
			handlers = new Set();
			this.#handlers.set(surfaceId, handlers);
		}
		handlers.add(handler);
		return () => {
			handlers?.delete(handler);
			if (handlers?.size === 0) this.#handlers.delete(surfaceId);
		};
	}

	registerLocalShortcutOwner(element: HTMLElement, owner: WorkspaceLocalShortcutOwner): () => void {
		let owners = this.#localOwners.get(element);
		if (!owners) {
			owners = new Set();
			this.#localOwners.set(element, owners);
		}
		owners.add(owner);
		return () => {
			owners?.delete(owner);
			if (owners?.size === 0) this.#localOwners.delete(element);
		};
	}

	noteScrollRegionInteraction(
		target: EventTarget | null,
		interaction: WorkspaceScrollInteraction,
	): void {
		const region = closestWorkspaceScrollRegion(target);
		const availableRegion = region && this.#isScrollRegionAvailable(region) ? region : null;
		if (interaction === 'focus') {
			const pendingPointerFocus = this.#pendingPointerFocus;
			this.#pendingPointerFocus = null;
			if (
				!availableRegion &&
				pendingPointerFocus &&
				target instanceof Node &&
				target.contains(pendingPointerFocus.region)
			) {
				return;
			}
		}
		if (interaction === 'pointer') {
			this.#pendingPointerFocus = availableRegion ? { region: availableRegion } : null;
		} else if (interaction === 'wheel') {
			this.#pendingPointerFocus = null;
		}
		this.#lastInteractedScrollRegion = availableRegion;
	}

	matchesGlobalShortcut(id: GlobalShortcutId, event: KeyboardEvent): boolean {
		const binding = getEffectiveGlobalShortcut(id, this.deps.localSettings.globalShortcuts);
		return binding ? globalShortcutMatchesEvent(binding, event) : false;
	}

	handle(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		if (event.key === 'Escape' && this.deps.transients.handleEscape(event)) return;
		const matches = (id: GlobalShortcutId) => this.matchesGlobalShortcut(id, event);
		const explicitOwner = this.#ownerForTarget(event.target);
		const modalOwnsTarget =
			(explicitOwner?.kind === 'surface' || explicitOwner?.kind === 'chat-list') &&
			this.deps.transients.ownsTopModalTarget(event.target);
		if (this.deps.transients.makesMainInert && !modalOwnsTarget) {
			return;
		}
		if (this.#isLocallyOwned(event)) return;
		const owner = explicitOwner ?? this.deps.workspace.focusOwner;
		const ownerDescriptor =
			owner.kind === 'surface' || owner.kind === 'window-chrome'
				? this.deps.workspace.layout.surface(owner.surfaceId)
				: null;
		const terminalOwnsInput =
			explicitOwner?.kind === 'surface' &&
			this.deps.workspace.isSurfacePresented(explicitOwner.surfaceId) &&
			this.deps.workspace.layout.surface(explicitOwner.surfaceId)?.type === 'terminal';
		if (matches('toggle-command-palette') && (!terminalOwnsInput || event.metaKey)) {
			event.preventDefault();
			this.#toggleCommandMenu?.();
			return;
		}
		if (matches('open-settings') && !terminalOwnsInput) {
			event.preventDefault();
			this.deps.appShell.openSettings();
			return;
		}
		if (matches('new-chat') && !terminalOwnsInput) {
			event.preventDefault();
			this.deps.appShell.requestNewChat();
			return;
		}
		const halfPageDirection: WorkspaceHalfPageDirection | null = matches('scroll-half-page-up')
			? 'earlier'
			: matches('scroll-half-page-down')
				? 'later'
				: null;
		if (halfPageDirection) {
			// Terminal input is the sole exception; editable targets still use workspace scrolling.
			if (ownerDescriptor?.type === 'terminal') return;
			event.preventDefault();
			event.stopPropagation();
			this.#scrollHalfPage(
				owner,
				event.target,
				halfPageDirection,
				this.deps.transients.makesMainInert,
			);
			return;
		}
		if (matches('cycle-window-focus')) {
			event.preventDefault();
			this.deps.workspace.cycleWindowFocus(owner);
			return;
		}
		if (matches('navigate-tab-left') || matches('navigate-tab-right')) {
			const handled = matches('navigate-tab-left')
				? this.deps.workspace.focusPreviousTabInFocusedWindow(owner)
				: this.deps.workspace.focusNextTabInFocusedWindow(owner);
			if (handled) event.preventDefault();
			return;
		}
		if (matches('navigate-chat-above') || matches('navigate-chat-below')) {
			if (owner.kind === 'chat-list') {
				event.preventDefault();
				if (matches('navigate-chat-above')) this.deps.navigation.requestNavigateChatAbove();
				else this.deps.navigation.requestNavigateChatBelow();
			}
			return;
		}
		if (owner.kind === 'surface' || owner.kind === 'window-chrome') {
			if (!this.deps.workspace.isSurfacePresented(owner.surfaceId)) return;
			const descriptor = this.deps.workspace.layout.surface(owner.surfaceId);
			if (descriptor?.type === 'terminal') return;
			if (
				descriptor?.type === 'file' &&
				globalShortcutMatchesEvent({ key: 's', primary: true }, event)
			) {
				event.preventDefault();
				void this.deps.files.save(descriptor.fileSessionId);
				return;
			}
			if (descriptor?.type === 'chat' && matches('open-sidebar-search')) {
				event.preventDefault();
				this.deps.appShell.openSidebarSearch();
				return;
			}
			if (descriptor?.type === 'chat' && matches('rename-chat')) {
				event.preventDefault();
				this.deps.appShell.requestRenameSelectedChat();
				return;
			}
			if (descriptor?.type === 'chat' && matches('delete-chat')) {
				event.preventDefault();
				this.deps.appShell.requestDeleteSelectedChat();
				return;
			}
			for (const handler of this.#handlers.get(owner.surfaceId) ?? []) {
				if (handler(event)) return;
			}
			return;
		}
		if (owner.kind !== 'chat-list') return;
		if (matches('open-sidebar-search')) {
			event.preventDefault();
			this.deps.appShell.openSidebarSearch();
		} else if (matches('rename-chat')) {
			event.preventDefault();
			this.deps.appShell.requestRenameSelectedChat();
		} else if (matches('delete-chat')) {
			event.preventDefault();
			this.deps.appShell.requestDeleteSelectedChat();
		}
	}

	#scrollHalfPage(
		owner: FocusOwner,
		target: EventTarget | null,
		direction: WorkspaceHalfPageDirection,
		restrictToTopModal: boolean,
	): void {
		const directRegion = closestWorkspaceScrollRegion(target);
		if (
			directRegion &&
			this.#isScrollRegionAvailable(directRegion) &&
			this.#ownersMatch(owner, this.#ownerForTarget(directRegion)) &&
			(!restrictToTopModal || this.deps.transients.ownsTopModalTarget(directRegion))
		) {
			scrollWorkspaceRegion(directRegion, direction);
			return;
		}
		if (typeof document === 'undefined') return;
		const regions = Array.from(
			document.querySelectorAll<HTMLElement>(WORKSPACE_SCROLL_REGION_SELECTOR),
		).filter(
			(region) =>
				this.#isScrollRegionAvailable(region) &&
				this.#ownersMatch(owner, this.#ownerForTarget(region)) &&
				(!restrictToTopModal || this.deps.transients.ownsTopModalTarget(region)),
		);
		const lastRegion = this.#lastInteractedScrollRegion;
		const region =
			(lastRegion && regions.includes(lastRegion) ? lastRegion : null) ??
			regions.find((candidate) => workspaceScrollRegionRole(candidate) === 'primary') ??
			regions[0];
		if (region) scrollWorkspaceRegion(region, direction);
	}

	#isScrollRegionAvailable(element: HTMLElement): boolean {
		return (
			element.isConnected &&
			workspaceScrollRegionRole(element) !== null &&
			!element.closest('[inert], [aria-hidden="true"]')
		);
	}

	#ownersMatch(owner: FocusOwner, candidate: FocusOwner | null): boolean {
		if (!candidate) return false;
		if (owner.kind === 'chat-list' || candidate.kind === 'chat-list') {
			return owner.kind === 'chat-list' && candidate.kind === 'chat-list';
		}
		return owner.surfaceId === candidate.surfaceId;
	}

	#ownerForTarget(target: EventTarget | null): FocusOwner | null {
		if (target instanceof Element) {
			const surface = target.closest<HTMLElement>('[data-workspace-surface-id]');
			if (surface?.dataset.workspaceSurfaceId) {
				return { kind: 'surface' as const, surfaceId: surface.dataset.workspaceSurfaceId };
			}
			if (target.closest('[data-workspace-chat-list]')) return { kind: 'chat-list' as const };
		}
		return null;
	}

	#isLocallyOwned(event: KeyboardEvent): boolean {
		if (this.#localOwners.size === 0) return false;
		const visited = new Set<HTMLElement>();
		for (const candidate of event.composedPath()) {
			if (!(candidate instanceof HTMLElement)) continue;
			visited.add(candidate);
			const owners = this.#localOwners.get(candidate);
			if (owners && [...owners].some((owner) => owner(event))) return true;
		}
		if (!(event.target instanceof Node)) return false;
		for (const [element, owners] of this.#localOwners) {
			if (visited.has(element)) continue;
			if (element.contains(event.target) && [...owners].some((owner) => owner(event))) return true;
		}
		return false;
	}
}
