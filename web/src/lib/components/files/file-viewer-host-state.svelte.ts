// Companion state class for FileViewerHost. Manages session lifecycle,
// file IO, mode switching, and the dirty-guard modal for markdown edits.

import { readText, saveText, getContentUrl } from '$lib/api/files';
import {
	resolveViewerMode,
	type FileViewerRequest,
	type FileViewerResolvedMode,
	type ActiveFileViewerSession,
} from '$lib/stores/file-viewer.svelte';

export interface FileViewerHostOptions {
	get request(): FileViewerRequest | null;
	consumeRequest: () => FileViewerRequest | null;
}

export interface LoadedFile {
	name: string;
	path: string;
	content: string;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

function isMarkdownPath(path: string): boolean {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	return MARKDOWN_EXTENSIONS.has(ext);
}

export class FileViewerHostState {
	session = $state<ActiveFileViewerSession | null>(null);
	file = $state<LoadedFile | null>(null);
	loading = $state(false);
	loadError = $state<string | null>(null);

	hasUnsavedChanges = $state(false);
	editorContent = $state('');

	confirmSwitchOpen = $state(false);
	pendingSwitchAction = $state<null | (() => Promise<void>)>(null);
	pendingSave = $state(false);
	switchError = $state<string | null>(null);

	activeReadController = $state<AbortController | null>(null);
	activeReadToken = $state(0);

	private readonly opts: FileViewerHostOptions;

	constructor(opts: FileViewerHostOptions) {
		this.opts = opts;
	}

	/** True when the current session is a markdown file open in code mode. */
	get isCurrentFileMarkdownInCodeMode(): boolean {
		if (!this.session || !this.file) return false;
		return this.session.mode === 'code' && isMarkdownPath(this.file.path);
	}

	/** Opens a viewer from a pending request, guarding for unsaved markdown. */
	async openFromRequest(req: FileViewerRequest): Promise<void> {
		const resolvedMode = resolveViewerMode(req.relativePath, req.preferredMode);
		const nextSession: ActiveFileViewerSession = {
			chatId: req.chatId,
			projectPath: req.projectPath,
			relativePath: req.relativePath,
			line: req.line,
			col: req.col,
			mode: resolvedMode,
			openedAt: Date.now(),
		};

		await this.runWithDirtyGuard(async () => {
			await this.loadSession(nextSession);
		});
	}

	/** Loads session content from the server. */
	private async loadSession(next: ActiveFileViewerSession): Promise<void> {
		this.abortRead();
		this.session = next;
		this.loadError = null;
		this.loading = true;

		const token = ++this.activeReadToken;
		const controller = new AbortController();
		this.activeReadController = controller;

		if (next.mode === 'image') {
			this.file = {
				name: next.relativePath.split('/').pop() ?? next.relativePath,
				path: next.relativePath,
				content: '',
			};
			this.editorContent = '';
			this.hasUnsavedChanges = false;
			this.loading = false;
			this.activeReadController = null;
			return;
		}

		try {
			const data = await readText(
				{
					chatId: next.chatId,
					projectPath: next.projectPath,
					filePath: next.relativePath,
				},
				{ signal: controller.signal },
			) as { content: string };

			if (token !== this.activeReadToken || controller.signal.aborted) return;

			this.file = {
				name: next.relativePath.split('/').pop() ?? next.relativePath,
				path: next.relativePath,
				content: data.content ?? '',
			};
			this.editorContent = this.file.content;
			this.hasUnsavedChanges = false;
		} catch (error) {
			if ((error as Error).name === 'AbortError') return;
			if (token !== this.activeReadToken) return;
			this.file = null;
			this.loadError = (error as Error).message;
		} finally {
			if (token === this.activeReadToken) {
				this.loading = false;
				this.activeReadController = null;
			}
		}
	}

	/** Guards against losing unsaved changes before running an action. */
	private async runWithDirtyGuard(action: () => Promise<void>): Promise<void> {
		if (!this.hasUnsavedChanges || !this.file) {
			await action();
			return;
		}
		this.switchError = null;
		this.pendingSwitchAction = action;
		this.confirmSwitchOpen = true;
	}

	/** Checks whether switching to the target mode requires a dirty guard. */
	private shouldGuardMarkdownSwitch(nextMode: FileViewerResolvedMode): boolean {
		const current = this.session;
		if (!current || !this.file) return false;
		if (current.mode !== 'code') return false;
		if (nextMode !== 'markdown') return false;
		if (!isMarkdownPath(this.file.path)) return false;
		return this.hasUnsavedChanges;
	}

	/** Switches the current session from code mode to markdown view. */
	async switchToMarkdownView(): Promise<void> {
		if (!this.session || !this.file) return;
		const runSwitch = async () => {
			this.session = { ...this.session!, mode: 'markdown' };
		};
		if (this.shouldGuardMarkdownSwitch('markdown')) {
			this.switchError = null;
			this.pendingSwitchAction = runSwitch;
			this.confirmSwitchOpen = true;
			return;
		}
		await runSwitch();
	}

	/** Switches the current session from markdown view to code mode. */
	switchToCodeView(): void {
		if (!this.session) return;
		this.session = { ...this.session, mode: 'code' };
	}

	/** Persists edited content to the server. */
	async saveCurrentFile(): Promise<void> {
		if (!this.session || !this.file) return;
		await saveText({
			chatId: this.session.chatId,
			projectPath: this.session.projectPath,
			filePath: this.file.path,
			content: this.editorContent,
		});
		this.file = { ...this.file, content: this.editorContent };
		this.hasUnsavedChanges = false;
	}

	/** Saves then executes the pending switch action. */
	async saveAndContinueSwitch(): Promise<void> {
		if (!this.pendingSwitchAction) return;
		this.pendingSave = true;
		this.switchError = null;
		try {
			await this.saveCurrentFile();
			const action = this.pendingSwitchAction;
			this.pendingSwitchAction = null;
			this.confirmSwitchOpen = false;
			await action();
		} catch (error) {
			this.switchError = (error as Error).message || 'Failed to save file.';
		} finally {
			this.pendingSave = false;
		}
	}

	/** Discards unsaved changes then executes the pending switch action. */
	async discardAndContinueSwitch(): Promise<void> {
		const action = this.pendingSwitchAction;
		this.pendingSwitchAction = null;
		this.confirmSwitchOpen = false;
		this.switchError = null;
		this.hasUnsavedChanges = false;
		if (!action) return;
		await action();
	}

	/** Cancels the pending switch, keeping the editor in its current state. */
	cancelSwitch(): void {
		this.confirmSwitchOpen = false;
		this.pendingSwitchAction = null;
		this.switchError = null;
	}

	/** Closes the viewer, guarding unsaved changes. */
	closeViewer(): void {
		if (this.hasUnsavedChanges && this.file) {
			this.switchError = null;
			this.pendingSwitchAction = async () => {
				this.resetViewer();
			};
			this.confirmSwitchOpen = true;
			return;
		}
		this.resetViewer();
	}

	/** Resets all viewer state. */
	private resetViewer(): void {
		this.abortRead();
		this.session = null;
		this.file = null;
		this.editorContent = '';
		this.hasUnsavedChanges = false;
		this.loadError = null;
	}

	/** Cancels any in-flight file read. */
	private abortRead(): void {
		this.activeReadController?.abort();
		this.activeReadController = null;
	}

	/** Returns the image content URL for the current session. */
	getImageUrl(): string {
		if (!this.session || !this.file) return '';
		return getContentUrl({
			chatId: this.session.chatId,
			projectPath: this.session.projectPath,
			filePath: this.file.path,
		});
	}

	/** Returns a file object suitable for FileEditorDialog. */
	toEditorFile(): { name: string; path: string; content: string; line?: number; col?: number } | null {
		if (!this.file) return null;
		return {
			...this.file,
			line: this.session?.line,
			col: this.session?.col,
		};
	}

	/** Updates editor content from CodeEditor onChange. */
	setEditorContent(value: string): void {
		this.editorContent = value;
		const baseline = this.file?.content ?? '';
		this.hasUnsavedChanges = this.file != null && value !== baseline;
	}

	/** Updates dirty flag from CodeEditor onDirtyChange. */
	setDirty(dirty: boolean): void {
		this.hasUnsavedChanges = dirty;
	}
}
