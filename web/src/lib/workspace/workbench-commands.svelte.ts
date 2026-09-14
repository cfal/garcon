import * as m from '$lib/paraglide/messages.js';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';
import {
	fileIdentityKey,
	type FileSessionRegistry,
} from '$lib/files/sessions/file-session-registry.svelte.js';
import type { FileEditorCommand } from '$lib/files/editor/code-editor-controller.svelte.js';
import { canSaveFileChanges } from '$lib/files/persistence/file-write-policy.js';
import {
	navigationViewPreference,
	rendererModeForNavigation,
	resolveFileRendererMode,
} from '$lib/files/sessions/file-open-mode.js';
import type { GhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
import type { FileLocation } from '$lib/files/navigation/file-navigation-store.svelte.js';
import type { FilesSurfaceController } from './singleton-surfaces.svelte.js';
import type { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import { windowIdOfSurface } from './window-tree.js';
import { copyToClipboard } from '$lib/utils/clipboard.js';
import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';

export type WorkbenchCommandCategory = 'Chat' | 'Navigation' | 'Workspace' | 'Editor' | 'File';

export interface WorkbenchCommandContext {
	viewId: string | null;
	surfaceId: string | null;
}

export interface WorkbenchCommand {
	id: string;
	label: string;
	description?: string;
	category: WorkbenchCommandCategory;
	isEnabled(context: WorkbenchCommandContext): boolean;
	isVisible?(context: WorkbenchCommandContext): boolean;
	run(context: WorkbenchCommandContext): unknown | Promise<unknown>;
}

export interface FileCommandSurfacePort {
	appendToChatDraft: ChatDraftAppend;
}

export interface WorkbenchCommandRegistryDeps {
	workspace: WorkspaceCoordinator;
	files: FileSessionRegistry;
	terminals: TerminalRegistry;
	appShell: AppShellStore;
	ghCapability: GhCapabilityStore;
	filesSurface(): FilesSurfaceController;
	filesSurfaceIfPresent(): FilesSurfaceController | null;
	onError(error: unknown): void;
	onInfo(message: string): void;
}

export class WorkbenchCommandRegistry {
	readonly #surfacePorts = new Map<string, FileCommandSurfacePort>();
	readonly commands: readonly WorkbenchCommand[];

	constructor(private readonly deps: WorkbenchCommandRegistryDeps) {
		this.commands = this.#createCommands();
	}

	get knownFileLocations(): readonly FileLocation[] {
		const tree = this.deps.filesSurfaceIfPresent()?.tree;
		const fileRootPath = tree?.fileRootPath;
		const byKey = new Map(
			(this.deps.files.navigation?.recents ?? []).map((location) => [location.key, location]),
		);
		if (tree && fileRootPath) {
			for (const entry of tree.knownFiles) {
				const key = fileIdentityKey(fileRootPath, entry.relativePath);
				if (byKey.has(key)) continue;
				byKey.set(key, {
					key,
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
				});
			}
		}
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
		return command ? this.invoke(command, context) : false;
	}

	isEnabled(id: string, context = this.context()): boolean {
		return this.commands.find((command) => command.id === id)?.isEnabled(context) ?? false;
	}

	async invoke(command: WorkbenchCommand, context = this.context()): Promise<boolean> {
		if (!command.isEnabled(context)) return false;
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

	async openLocation(location: FileLocation, context = this.context()): Promise<boolean> {
		const origin = context.surfaceId
			? windowIdOfSurface(this.deps.workspace.layout.snapshot.desktopRoot, context.surfaceId)
			: null;
		const opened = await this.deps.files.open({
			fileRootPath: location.canonicalFileRootPath,
			relativePath: location.normalizedRelativePath,
			mode: rendererModeForNavigation(location.viewPreference),
			origin: origin ?? 'window-main',
			reason: 'user-open',
			line: location.line,
			col: location.column,
		});
		return opened !== null;
	}

	async #navigateHistory(
		direction: 'back' | 'forward',
		context: WorkbenchCommandContext,
	): Promise<void> {
		const navigation = this.deps.files.navigation;
		const location = navigation?.[direction]();
		if (!navigation || !location) return;
		try {
			navigation.completeNavigation(await this.openLocation(location, context));
		} catch (error) {
			navigation.completeNavigation(false);
			throw error;
		}
	}

	#createCommands(): WorkbenchCommand[] {
		const always = () => true;
		const fileWindowId = ({ viewId, surfaceId }: WorkbenchCommandContext) => {
			if (this.deps.workspace.isMobile || !viewId || !surfaceId || !this.deps.files.get(viewId))
				return null;
			return windowIdOfSurface(this.deps.workspace.layout.snapshot.desktopRoot, surfaceId);
		};
		const editor = (id: string, label: string, command: FileEditorCommand): WorkbenchCommand => ({
			id,
			label,
			category: 'Editor',
			isVisible: ({ viewId }) => viewId !== null,
			isEnabled: ({ viewId }) => {
				const session = viewId ? this.deps.files.get(viewId) : null;
				return session?.editor?.canRun(command) ?? false;
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
				isEnabled: always,
				run: () => this.deps.appShell.openNewChatDialog(),
			},
			{
				id: 'open-settings',
				label: m.command_open_settings(),
				description: m.command_open_settings_desc(),
				category: 'Navigation',
				isEnabled: always,
				run: () => this.deps.appShell.openSettings(),
			},
			...this.#workspaceCommands(always),
			{
				id: 'file.save',
				label: m.editor_actions_save(),
				category: 'File',
				isVisible: ({ viewId }) => viewId !== null,
				isEnabled: ({ viewId }) => {
					const session = viewId ? this.deps.files.get(viewId) : null;
					return session !== null && canSaveFileChanges(session);
				},
				run: ({ viewId }) => (viewId ? this.deps.files.save(viewId) : undefined),
			},
			editor('editor.find', m.editor_command_find(), 'find'),
			{
				id: 'file.open-to-side',
				label: m.file_command_open_to_side(),
				category: 'File',
				isVisible: (context) => Boolean(fileWindowId(context)),
				isEnabled: (context) => Boolean(fileWindowId(context)),
				run: (context) => {
					const windowId = fileWindowId(context);
					if (context.viewId && windowId)
						return this.deps.files.openToSide(context.viewId, windowId);
				},
			},
			editor('editor.replace', m.editor_command_replace(), 'replace'),
			editor('editor.go-to-line', m.editor_command_go_to_line(), 'go-to-line'),
			editor(
				'editor.go-to-matching-bracket',
				m.editor_command_matching_bracket(),
				'go-to-matching-bracket',
			),
			editor('editor.undo', m.editor_command_undo(), 'undo'),
			editor('editor.redo', m.editor_command_redo(), 'redo'),
			editor('editor.indent', m.editor_command_indent(), 'indent'),
			editor('editor.outdent', m.editor_command_outdent(), 'outdent'),
			editor('editor.toggle-comment', m.editor_command_toggle_comment(), 'toggle-comment'),
			editor('editor.fold', m.editor_command_fold(), 'fold'),
			editor('editor.unfold', m.editor_command_unfold(), 'unfold'),
			editor('editor.fold-all', m.editor_command_fold_all(), 'fold-all'),
			editor('editor.unfold-all', m.editor_command_unfold_all(), 'unfold-all'),
			editor('editor.duplicate-line-up', m.editor_command_duplicate_line_up(), 'duplicate-line-up'),
			editor(
				'editor.duplicate-line-down',
				m.editor_command_duplicate_line_down(),
				'duplicate-line-down',
			),
			editor('editor.move-line-up', m.editor_command_move_line_up(), 'move-line-up'),
			editor('editor.move-line-down', m.editor_command_move_line_down(), 'move-line-down'),
			editor('editor.delete-line', m.editor_command_delete_line(), 'delete-line'),
			editor(
				'editor.select-next-occurrence',
				m.editor_command_select_next_occurrence(),
				'select-next-occurrence',
			),
			{
				id: 'file.navigate-back',
				label: m.file_command_history_back(),
				category: 'Navigation',
				isEnabled: () => this.deps.files.navigation?.canGoBack ?? false,
				run: async (context) => {
					await this.#navigateHistory('back', context);
				},
			},
			{
				id: 'file.navigate-forward',
				label: m.file_command_history_forward(),
				category: 'Navigation',
				isEnabled: () => this.deps.files.navigation?.canGoForward ?? false,
				run: async (context) => {
					await this.#navigateHistory('forward', context);
				},
			},
			{
				id: 'file.reveal-active',
				label: m.file_command_reveal(),
				category: 'File',
				isVisible: ({ viewId }) => viewId !== null,
				isEnabled: ({ viewId }) => Boolean(viewId && this.deps.files.get(viewId)),
				run: async ({ viewId }) => {
					const session = viewId ? this.deps.files.get(viewId) : null;
					if (!session) return;
					await this.deps.workspace.openSingleton('files');
					this.deps.filesSurface().revealFile(session.canonicalFileRootPath, session.relativePath);
				},
			},
			{
				id: 'file.copy-location',
				label: m.file_command_copy_location(),
				category: 'File',
				isVisible: ({ viewId }) => viewId !== null,
				isEnabled: ({ viewId }) => Boolean(viewId && this.deps.files.get(viewId)),
				run: async ({ viewId }) => {
					const session = viewId ? this.deps.files.get(viewId) : null;
					if (!session) return;
					const location = session.editor?.selectionLocation() ?? { line: 1, column: 1 };
					const copied = await copyToClipboard(
						`${session.relativePath}:${location.line}:${location.column}`,
					);
					if (!copied) throw new Error(m.file_command_copy_failed());
					this.deps.onInfo(m.shell_copied());
				},
			},
			{
				id: 'file.send-to-chat',
				label: m.file_command_add_selection(),
				category: 'File',
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
					const result = port.appendToChatDraft(
						text
							? `\`${session.relativePath}${suffix}\`\n\n\`\`\`\n${text}\n\`\`\``
							: `\`${session.relativePath}${suffix}\``,
					);
					if (result === 'unavailable') throw new Error(m.file_command_chat_unavailable());
					this.deps.onInfo(
						result === 'appended'
							? m.file_command_chat_appended()
							: m.file_command_chat_duplicate(),
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
			isEnabled: always,
			run: () => this.deps.workspace.openSingleton(kind),
		});
		return [
			{
				id: 'workspace-chat',
				label: m.command_switch_to_chat(),
				category: 'Workspace',
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
				isEnabled: always,
				run: () => this.deps.workspace.focusMostRecentTerminalOrCreate(),
			},
			{
				id: 'workspace-new-terminal',
				label: m.workspace_new_terminal(),
				category: 'Workspace',
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
