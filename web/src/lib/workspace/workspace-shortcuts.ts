import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { NavigationStore } from '$lib/stores/navigation.svelte.js';
import type { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import type { TransientLayerRegistry } from './transient-layers.svelte.js';

export type WorkspaceSurfaceShortcutHandler = (event: KeyboardEvent) => boolean;

interface WorkspaceShortcutDeps {
	workspace: WorkspaceCoordinator;
	transients: TransientLayerRegistry;
	appShell: AppShellStore;
	navigation: NavigationStore;
	files: FileSessionRegistry;
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
		// A focused control can defer Escape to its target handler before global
		// transient and surface routing runs in the capture phase.
		if (event.key === 'Escape' && this.#targetOwnsEscape(event.target)) return;
		if (event.key === 'Escape' && this.deps.transients.handleEscape(event)) return;
		const key = event.key.toLowerCase();
		const command = event.ctrlKey || event.metaKey;
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
		if (command && !event.shiftKey && key === 'p' && (!terminalOwnsInput || event.metaKey)) {
			event.preventDefault();
			this.#toggleCommandMenu?.();
			return;
		}
		if (event.ctrlKey && key === ',') {
			event.preventDefault();
			this.deps.appShell.openSettings();
			return;
		}
		if (event.ctrlKey && !event.shiftKey && key === 'n' && !terminalOwnsInput) {
			event.preventDefault();
			this.deps.appShell.requestNewChat();
			return;
		}
		if (event.ctrlKey && event.shiftKey && key === 'o') {
			event.preventDefault();
			this.deps.workspace.toggleFocusBetweenMainAndSidebar(owner);
			return;
		}
		if (event.ctrlKey && event.shiftKey && (key === 'j' || key === 'l')) {
			const handled =
				key === 'j'
					? this.deps.workspace.focusPreviousTabInFocusedHost(owner)
					: this.deps.workspace.focusNextTabInFocusedHost(owner);
			if (handled) event.preventDefault();
			return;
		}
		if (event.ctrlKey && event.shiftKey && (key === 'p' || key === 'n')) {
			if (owner.kind === 'chat-list') {
				event.preventDefault();
				if (key === 'p') this.deps.navigation.requestNavigateChatAbove();
				else this.deps.navigation.requestNavigateChatBelow();
			}
			return;
		}
		if (owner.kind === 'surface' || owner.kind === 'host-chrome') {
			if (!this.deps.workspace.isSurfacePresented(owner.surfaceId)) return;
			const descriptor = this.deps.workspace.layout.surface(owner.surfaceId);
			if (descriptor?.type === 'terminal') return;
			if (descriptor?.type === 'file' && command && key === 's') {
				event.preventDefault();
				void this.deps.files.save(descriptor.fileSessionId);
				return;
			}
			if (
				descriptor?.type === 'singleton' &&
				descriptor.kind === 'chat' &&
				command &&
				key === 's'
			) {
				event.preventDefault();
				this.deps.appShell.openSidebarSearch();
				return;
			}
			for (const handler of this.#handlers.get(owner.surfaceId) ?? []) {
				if (handler(event)) return;
			}
			return;
		}
		if (owner.kind !== 'chat-list') return;
		if (command && key === 's') {
			event.preventDefault();
			this.deps.appShell.openSidebarSearch();
		} else if (event.ctrlKey && key === 'r') {
			event.preventDefault();
			this.deps.appShell.requestRenameSelectedChat();
		} else if (event.ctrlKey && key === 'd') {
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

	#targetOwnsEscape(target: EventTarget | null): boolean {
		return target instanceof Element && target.closest('[data-local-escape-owner]') !== null;
	}
}
