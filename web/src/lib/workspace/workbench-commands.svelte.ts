import * as m from '$lib/paraglide/messages.js';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { FileEditorCommand } from '$lib/files/editor/code-editor-controller.svelte.js';
import {
	navigationViewPreference,
	resolveFileRendererMode,
} from '$lib/files/sessions/file-open-mode.js';
import type { GhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
import {
	getDefaultGlobalShortcut,
	type GlobalShortcutBinding,
	type GlobalShortcutId,
} from './global-shortcuts.js';
import type { FileLocation } from '$lib/files/navigation/file-navigation-store.svelte.js';
import type { FilesSurfaceController } from './singleton-surfaces.svelte.js';
import type { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import { filePathRelativeToTreeRoot } from '$lib/files/tree/file-tree-path.js';

export type WorkbenchCommandCategory = 'Chat' | 'Navigation' | 'Workspace' | 'Editor' | 'File';

export interface WorkbenchCommandContext {
	viewId: string | null;
	surfaceId: string | null;
}

export interface WorkbenchCommand<Context = WorkbenchCommandContext> {
	id: string;
	label: string;
	description?: string;
	category: WorkbenchCommandCategory;
	defaultBindings: readonly GlobalShortcutBinding[];
	isEnabled(context: Context): boolean;
	isVisible?(context: Context): boolean;
	run(context: Context): unknown | Promise<unknown>;
}

export interface FileCommandSurfacePort {
	appendToChatDraft(block: string): boolean;
}

function defaultBindingsFor(id: GlobalShortcutId): readonly GlobalShortcutBinding[] {
	const binding = getDefaultGlobalShortcut(id);
	return binding ? [binding] : [];
}

function openModeForLocation(location: FileLocation): 'code' | 'markdown' | 'image' {
	switch (location.viewPreference) {
		case 'image':
			return 'image';
		case 'preview':
			return 'markdown';
		case 'source':
			return 'code';
	}
}

export interface WorkbenchCommandRegistryDeps {
	workspace: WorkspaceCoordinator;
	files: FileSessionRegistry;
	terminals: TerminalRegistry;
	appShell: AppShellStore;
	ghCapability: GhCapabilityStore;
	filesSurface(): FilesSurfaceController;
	onError(error: unknown): void;
}

export class WorkbenchCommandRegistry {
	readonly #surfacePorts = new Map<string, FileCommandSurfacePort>();
	readonly commands: readonly WorkbenchCommand[];

	constructor(private readonly deps: WorkbenchCommandRegistryDeps) {
		this.commands = this.#createCommands();
	}

	get knownFileLocations(): readonly FileLocation[] {
		const known = this.deps.filesSurface().tree.knownFiles.flatMap((entry) => {
			const fileRootPath = this.deps.filesSurface().tree.fileRootPath;
			if (!fileRootPath) return [];
			return [
				{
					key: JSON.stringify([fileRootPath, entry.relativePath]),
					canonicalFileRootPath: fileRootPath,
					normalizedRelativePath: entry.relativePath,
					displayPath: entry.relativePath,
					revision: null,
					line: 1,
					column: 1,
					viewPreference: navigationViewPreference(
						resolveFileRendererMode(entry.relativePath, 'auto'),
					),
					timestamp: 0,
				},
			];
		});
		const byKey = new Map(
			(this.deps.files.navigation?.recents ?? []).map((location) => [location.key, location]),
		);
		for (const location of known) if (!byKey.has(location.key)) byKey.set(location.key, location);
		return [...byKey.values()];
	}

	context(): WorkbenchCommandContext {
		const owner = this.deps.workspace.focusOwner;
		if (owner.kind === 'chat-list') return { viewId: null, surfaceId: null };
		const surfaceId = owner.surfaceId;
		const surface = this.deps.workspace.layout.surface(surfaceId);
		return {
			surfaceId,
			viewId: surface?.type === 'file' ? surface.fileSessionId : null,
		};
	}

	available(context = this.context()): readonly WorkbenchCommand[] {
		return this.commands.filter((command) => command.isVisible?.(context) ?? true);
	}

	async execute(id: string, context = this.context()): Promise<boolean> {
		const command = this.commands.find((candidate) => candidate.id === id);
		if (!command || !command.isEnabled(context)) return false;
		try {
			await command.run(context);
			return true;
		} catch (error) {
			this.deps.onError(error);
			return false;
		}
	}

	registerFileSurface(viewId: string, port: FileCommandSurfacePort): () => void {
		this.#surfacePorts.set(viewId, port);
		return () => {
			if (this.#surfacePorts.get(viewId) === port) this.#surfacePorts.delete(viewId);
		};
	}

	async openLocation(location: FileLocation): Promise<boolean> {
		const opened = await this.deps.files.open({
			fileRootPath: location.canonicalFileRootPath,
			relativePath: location.normalizedRelativePath,
			mode: openModeForLocation(location),
			origin: 'window-main',
			reason: 'user-open',
			line: location.line,
			col: location.column,
		});
		return opened !== null;
	}

	async #navigateHistory(direction: 'back' | 'forward'): Promise<void> {
		const navigation = this.deps.files.navigation;
		const location = navigation?.[direction]();
		if (!navigation || !location) return;
		try {
			navigation.completeNavigation(await this.openLocation(location));
		} catch (error) {
			navigation.completeNavigation(false);
			throw error;
		}
	}

	#createCommands(): WorkbenchCommand[] {
		const always = () => true;
		const editor = (
			id: string,
			label: string,
			command: FileEditorCommand,
			bindings: readonly GlobalShortcutBinding[] = [],
		): WorkbenchCommand => ({
			id,
			label,
			category: 'Editor',
			defaultBindings: bindings,
			isVisible: ({ viewId }) => viewId !== null,
			isEnabled: ({ viewId }) => {
				const session = viewId ? this.deps.files.get(viewId) : null;
				return Boolean(session?.editor?.isAttached);
			},
			run: ({ viewId }) => {
				if (viewId) this.deps.files.get(viewId)?.editor?.run(command);
			},
		});
		return [
			{
				id: 'new-chat',
				label: m.command_new_chat(),
				description: m.command_new_chat_desc(),
				category: 'Chat',
				defaultBindings: [],
				isEnabled: always,
				run: () => this.deps.appShell.openNewChatDialog(),
			},
			{
				id: 'open-settings',
				label: m.command_open_settings(),
				description: m.command_open_settings_desc(),
				category: 'Navigation',
				defaultBindings: [],
				isEnabled: always,
				run: () => this.deps.appShell.openSettings(),
			},
			...this.#workspaceCommands(always),
			{
				id: 'file.save',
				label: m.editor_actions_save(),
				category: 'File',
				defaultBindings: defaultBindingsFor('file-save'),
				isVisible: ({ viewId }) => viewId !== null,
				isEnabled: ({ viewId }) => {
					const session = viewId ? this.deps.files.get(viewId) : null;
					return Boolean(
						session?.dirty && !session.saving && !session.mutationGuarded && !session.readOnly,
					);
				},
				run: ({ viewId }) => (viewId ? this.deps.files.save(viewId) : undefined),
			},
			editor('editor.find', 'Find', 'find', defaultBindingsFor('editor-find')),
			editor('editor.replace', 'Replace', 'replace', defaultBindingsFor('editor-replace')),
			editor(
				'editor.go-to-line',
				'Go to Line',
				'go-to-line',
				defaultBindingsFor('editor-go-to-line'),
			),
			editor(
				'editor.go-to-matching-bracket',
				'Go to Matching Bracket',
				'go-to-matching-bracket',
				defaultBindingsFor('editor-go-to-matching-bracket'),
			),
			editor('editor.undo', 'Undo', 'undo'),
			editor('editor.redo', 'Redo', 'redo'),
			editor('editor.indent', 'Indent Line', 'indent', defaultBindingsFor('editor-indent')),
			editor('editor.outdent', 'Outdent Line', 'outdent', defaultBindingsFor('editor-outdent')),
			editor(
				'editor.toggle-comment',
				'Toggle Comment',
				'toggle-comment',
				defaultBindingsFor('editor-toggle-comment'),
			),
			editor('editor.fold', 'Fold', 'fold'),
			editor('editor.unfold', 'Unfold', 'unfold'),
			editor('editor.fold-all', 'Fold All', 'fold-all'),
			editor('editor.unfold-all', 'Unfold All', 'unfold-all'),
			editor(
				'editor.duplicate-line-up',
				'Duplicate Line Up',
				'duplicate-line-up',
				defaultBindingsFor('editor-duplicate-line-up'),
			),
			editor(
				'editor.duplicate-line-down',
				'Duplicate Line Down',
				'duplicate-line-down',
				defaultBindingsFor('editor-duplicate-line-down'),
			),
			editor(
				'editor.move-line-up',
				'Move Line Up',
				'move-line-up',
				defaultBindingsFor('editor-move-line-up'),
			),
			editor(
				'editor.move-line-down',
				'Move Line Down',
				'move-line-down',
				defaultBindingsFor('editor-move-line-down'),
			),
			editor(
				'editor.delete-line',
				'Delete Line',
				'delete-line',
				defaultBindingsFor('editor-delete-line'),
			),
			editor('editor.select-next-occurrence', 'Select Next Occurrence', 'select-next-occurrence'),
			{
				id: 'file.open-known',
				label: 'Open Known File',
				category: 'File',
				defaultBindings: [],
				isVisible: () => (this.deps.files.navigation?.recents.length ?? 0) > 0,
				isEnabled: () => (this.deps.files.navigation?.recents.length ?? 0) > 0,
				run: () => {
					const location = this.deps.files.navigation?.recents[0];
					return location ? this.openLocation(location) : undefined;
				},
			},
			{
				id: 'file.navigate-back',
				label: 'Go Back in File History',
				category: 'Navigation',
				defaultBindings: defaultBindingsFor('file-navigate-back'),
				isEnabled: () => true,
				run: async () => {
					await this.#navigateHistory('back');
				},
			},
			{
				id: 'file.navigate-forward',
				label: 'Go Forward in File History',
				category: 'Navigation',
				defaultBindings: defaultBindingsFor('file-navigate-forward'),
				isEnabled: () => true,
				run: async () => {
					await this.#navigateHistory('forward');
				},
			},
			{
				id: 'file.reveal-active',
				label: 'Reveal Active File in Explorer',
				category: 'File',
				defaultBindings: [],
				isVisible: ({ viewId }) => viewId !== null,
				isEnabled: ({ viewId }) => Boolean(viewId && this.deps.files.get(viewId)),
				run: async ({ viewId }) => {
					const session = viewId ? this.deps.files.get(viewId) : null;
					if (!session) return;
					await this.deps.workspace.openSingleton('files');
					const tree = this.deps.filesSurface().tree;
					const relativePath = tree.fileRootPath
						? filePathRelativeToTreeRoot(
								tree.fileRootPath,
								session.canonicalFileRootPath,
								session.relativePath,
							)
						: null;
					if (relativePath) await tree.revealFile(relativePath);
				},
			},
			{
				id: 'file.copy-location',
				label: 'Copy File Location',
				category: 'File',
				defaultBindings: [],
				isVisible: ({ viewId }) => viewId !== null,
				isEnabled: ({ viewId }) => Boolean(viewId && this.deps.files.get(viewId)),
				run: async ({ viewId }) => {
					const session = viewId ? this.deps.files.get(viewId) : null;
					if (!session) return;
					const location = session.editor?.selectionLocation() ?? { line: 1, column: 1 };
					await navigator.clipboard.writeText(
						`${session.relativePath}:${location.line}:${location.column}`,
					);
				},
			},
			{
				id: 'file.send-to-chat',
				label: 'Add Selection to Chat Draft',
				category: 'File',
				defaultBindings: [],
				isVisible: ({ viewId }) => viewId !== null,
				isEnabled: ({ viewId }) => Boolean(viewId && this.#surfacePorts.has(viewId)),
				run: ({ viewId }) => {
					if (!viewId) return;
					const session = this.deps.files.get(viewId);
					const port = this.#surfacePorts.get(viewId);
					if (!session || !port) return;
					const location = session.editor?.selectionLocation();
					const text = session.editor?.selectedText();
					const suffix = location ? `:${location.line}:${location.column}` : '';
					port.appendToChatDraft(
						text
							? `\`${session.relativePath}${suffix}\`\n\n\`\`\`\n${text}\n\`\`\``
							: `\`${session.relativePath}${suffix}\``,
					);
				},
			},
		];
	}

	#workspaceCommands(always: () => boolean): WorkbenchCommand[] {
		const open = (
			id: string,
			label: string,
			kind: Parameters<WorkspaceCoordinator['openSingleton']>[0],
		) => ({
			id,
			label,
			category: 'Workspace' as const,
			defaultBindings: [],
			isEnabled: always,
			run: () => this.deps.workspace.openSingleton(kind),
		});
		return [
			{
				id: 'workspace-chat',
				label: m.command_switch_to_chat(),
				category: 'Workspace',
				defaultBindings: [],
				isEnabled: always,
				run: () => this.deps.workspace.focusChat(),
			},
			open('workspace-files', m.command_switch_to_files(), 'files'),
			open('workspace-chat-map', m.workspace_open_chat_map(), 'chat-map'),
			open('workspace-chat-canvas', m.workspace_open_chat_canvas(), 'chat-canvas'),
			open('workspace-chat-board', m.workspace_open_chat_board(), 'chat-board'),
			{
				id: 'workspace-terminal',
				label: m.command_switch_to_terminal(),
				category: 'Workspace',
				defaultBindings: [],
				isEnabled: always,
				run: () => this.deps.workspace.focusMostRecentTerminalOrCreate(),
			},
			{
				id: 'workspace-new-terminal',
				label: m.workspace_new_terminal(),
				category: 'Workspace',
				defaultBindings: [],
				isVisible: () =>
					this.deps.terminals.listStatus === 'ready' &&
					this.deps.terminals.orderedSessions.length < TERMINAL_SESSION_LIMIT,
				isEnabled: always,
				run: () => this.deps.workspace.createTerminalInAvailableSpace('command-menu:new-terminal'),
			},
			open('workspace-git', m.command_switch_to_git(), 'git'),
			open('workspace-git-history', m.workspace_surface_git_history(), 'git-history'),
			open('workspace-git-compare', m.workspace_surface_git_compare(), 'git-compare'),
			{
				...open('workspace-pull-requests', m.workspace_surface_pull_requests(), 'pull-requests'),
				isVisible: () => this.deps.ghCapability.available || !this.deps.ghCapability.hasChecked,
			},
			open('workspace-commit', m.workspace_surface_commit(), 'commit'),
		];
	}
}
