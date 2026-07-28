import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { NavigationStore } from '$lib/stores/navigation.svelte.js';
import type { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';
import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import {
	getEffectiveGlobalShortcut,
	globalShortcutMatchesEvent,
	type GlobalShortcutId,
} from './global-shortcuts.js';

export type WorkspaceSurfaceShortcutHandler = (event: KeyboardEvent) => boolean;

interface WorkspaceShortcutDeps {
	workspace: WorkspaceCoordinator;
	transients: TransientLayerRegistry;
	appShell: AppShellStore;
	navigation: NavigationStore;
	files: FileSessionRegistry;
	localSettings: Pick<LocalSettingsStore, 'globalShortcuts'>;
}

export class WorkspaceShortcutDispatcher {
	readonly #handlers = new Map<string, Set<WorkspaceSurfaceShortcutHandler>>();
	#toggleCommandMenu: (() => void) | null = null;

	constructor(private readonly deps: WorkspaceShortcutDeps) {}

	setCommandMenuHandler(handler: (() => void) | null): void {
		this.#toggleCommandMenu = handler;
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

	handle(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		if (event.key === 'Escape' && this.deps.transients.handleEscape(event)) return;
		const matches = (id: GlobalShortcutId) => {
			const binding = getEffectiveGlobalShortcut(id, this.deps.localSettings.globalShortcuts);
			return binding ? globalShortcutMatchesEvent(binding, event) : false;
		};
		const explicitOwner = this.#ownerForTarget(event.target);
		const modalSurfaceOwnsTarget =
			explicitOwner?.kind === 'surface' && this.deps.transients.ownsTopModalTarget(event.target);
		if (this.deps.transients.makesMainInert && !modalSurfaceOwnsTarget) {
			return;
		}
		const owner = explicitOwner ?? this.deps.workspace.focusOwner;
		const terminalOwnsInput =
			explicitOwner?.kind === 'surface' &&
			this.deps.workspace.isSurfacePresented(explicitOwner.surfaceId) &&
			this.deps.workspace.layout.surface(explicitOwner.surfaceId)?.type === 'terminal';
		if (matches('toggle-command-palette') && (!terminalOwnsInput || event.metaKey)) {
			event.preventDefault();
			this.#toggleCommandMenu?.();
			return;
		}
		if (matches('open-settings')) {
			event.preventDefault();
			this.deps.appShell.openSettings();
			return;
		}
		if (matches('new-chat') && !terminalOwnsInput) {
			event.preventDefault();
			this.deps.appShell.requestNewChat();
			return;
		}
		if (matches('toggle-main-sidebar-focus')) {
			event.preventDefault();
			this.deps.workspace.toggleFocusBetweenMainAndSidebar(owner);
			return;
		}
		if (matches('navigate-tab-left') || matches('navigate-tab-right')) {
			const handled = matches('navigate-tab-left')
				? this.deps.workspace.focusPreviousTabInFocusedHost(owner)
				: this.deps.workspace.focusNextTabInFocusedHost(owner);
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
		if (owner.kind === 'surface' || owner.kind === 'host-chrome') {
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
			if (
				descriptor?.type === 'singleton' &&
				descriptor.kind === 'chat' &&
				matches('open-sidebar-search')
			) {
				event.preventDefault();
				this.deps.appShell.openSidebarSearch();
				return;
			}
			if (
				descriptor?.type === 'singleton' &&
				descriptor.kind === 'chat' &&
				matches('delete-chat')
			) {
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

	#ownerForTarget(target: EventTarget | null) {
		if (target instanceof Element) {
			const surface = target.closest<HTMLElement>('[data-workspace-surface-id]');
			if (surface?.dataset.workspaceSurfaceId) {
				return { kind: 'surface' as const, surfaceId: surface.dataset.workspaceSurfaceId };
			}
			if (target.closest('[data-workspace-chat-list]')) return { kind: 'chat-list' as const };
		}
		return null;
	}
}
