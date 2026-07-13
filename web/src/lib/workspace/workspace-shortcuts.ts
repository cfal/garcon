import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { FileSessionRegistry } from '$lib/stores/file-sessions.svelte.js';
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
		if (event.key === 'Escape' && this.deps.transients.handleEscape(event)) return;
		const key = event.key.toLowerCase();
		const command = event.ctrlKey || event.metaKey;
		if (command && key === 'p') {
			event.preventDefault();
			this.#toggleCommandMenu?.();
			return;
		}
		if (event.ctrlKey && key === ',') {
			event.preventDefault();
			this.deps.appShell.openSettings();
			return;
		}
		if (event.ctrlKey && key === 'n') {
			event.preventDefault();
			this.deps.appShell.requestNewChat();
			return;
		}

		const owner = this.#ownerFor(event.target);
		if (owner.kind === 'surface' || owner.kind === 'host-chrome') {
			const descriptor = this.deps.workspace.layout.surface(owner.surfaceId);
			if (descriptor?.type === 'terminal') return;
			if (descriptor?.type === 'file' && command && key === 's') {
				event.preventDefault();
				void this.deps.files.save(descriptor.fileSessionId);
				return;
			}
			if (descriptor?.type === 'singleton' && descriptor.kind === 'chat' && command && key === 's') {
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
		} else if (event.ctrlKey && event.shiftKey && key === 'j') {
			event.preventDefault();
			this.deps.navigation.requestNavigateChatAbove();
		} else if (event.ctrlKey && event.shiftKey && key === 'l') {
			event.preventDefault();
			this.deps.navigation.requestNavigateChatBelow();
		}
	}

	#ownerFor(target: EventTarget | null) {
		if (target instanceof Element) {
			const surface = target.closest<HTMLElement>('[data-workspace-surface-id]');
			if (surface?.dataset.workspaceSurfaceId) {
				return { kind: 'surface' as const, surfaceId: surface.dataset.workspaceSurfaceId };
			}
			if (target.closest('[data-workspace-chat-list]')) return { kind: 'chat-list' as const };
		}
		return this.deps.workspace.focusOwner;
	}
}
