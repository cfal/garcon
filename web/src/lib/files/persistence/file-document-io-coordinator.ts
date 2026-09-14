import { getFileRevision, readContent, readText } from '$lib/api/files.js';
import type {
	CodeEditorController,
	EditorPresentationSettings,
} from '$lib/files/editor/code-editor-controller.svelte.js';
import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { DocumentPollingCoordinator } from '$lib/files/persistence/document-polling-coordinator.js';
import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import { fileTextMetadata } from '$lib/files/documents/file-text-metadata.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { ModuleImportError } from '$lib/utils/module-import-error.js';
import type { FileRevision } from '$shared/file-contracts';

export interface FileEditorRuntimeModule {
	CodeEditorController: new (
		session: FileViewSession,
		settings: EditorPresentationSettings,
		onSave?: () => void,
	) => CodeEditorController;
}

type LoadedFileContent =
	| { kind: 'text'; content: string; revision: FileRevision }
	| { kind: 'image'; blob: Blob; revision: FileRevision };

export interface FileDiskSnapshot {
	readonly content: string;
	readonly revision: FileRevision;
}

interface FileDocumentIoOptions {
	getSession(sessionId: string): FileViewSession | null;
	getDocument(documentId: string): FileDocumentState | null;
	getEditorSettings(): EditorPresentationSettings;
	save?(sessionId: string): void;
	getFileRevision?: typeof getFileRevision;
	readText?: typeof readText;
	readContent?: typeof readContent;
	loadEditorRuntime?: () => Promise<FileEditorRuntimeModule>;
	reloadApplication?: () => void;
	isDocumentVisible(documentId: string): boolean;
}

async function loadEditorRuntime(): Promise<FileEditorRuntimeModule> {
	try {
		return await import('$lib/files/editor/code-editor-controller.svelte.js');
	} catch (error) {
		throw new ModuleImportError(error);
	}
}

function reloadApplication(): void {
	if (typeof window !== 'undefined') window.location.reload();
}

export class FileDocumentIoCoordinator {
	readonly #documentLoads = new Map<string, Promise<void>>();
	#editorRuntimePromise: Promise<FileEditorRuntimeModule> | null = null;
	readonly #polling: DocumentPollingCoordinator;

	constructor(private readonly options: FileDocumentIoOptions) {
		this.#polling = new DocumentPollingCoordinator({
			poll: (documentId) => this.#checkDocumentFreshness(documentId),
			isVisible: (documentId) => options.isDocumentVisible(documentId),
		});
	}

	startPolling(documentId: string): void {
		this.#polling.add(documentId);
	}

	stopPolling(documentId: string): void {
		this.#polling.remove(documentId);
	}

	visibilityChanged(documentId: string): void {
		this.#polling.visibilityChanged(documentId);
	}

	destroy(): void {
		this.#polling.destroy();
	}

	async loadInitial(session: FileViewSession): Promise<void> {
		const document = session.document;
		if (document.dirty) return;
		const existing = this.#documentLoads.get(document.id);
		if (existing) {
			await existing;
			if (this.#documentLoads.get(document.id) === existing)
				this.#documentLoads.delete(document.id);
			if (!document.loadError) {
				await this.ensureEditorForView(session);
				return;
			}
		}
		const controller = new AbortController();
		document.loadController = controller;
		document.loading = true;
		document.loadError = null;
		document.loadErrorRequiresPageReload = false;
		document.editorInitializationFailed = false;
		const operation = (async () => {
			try {
				const [loaded, runtime] = await Promise.all([
					this.#readLatest(session, controller.signal),
					this.#loadEditorRuntimeIfNeeded(session),
				]);
				if (!this.#isCurrentInitialLoad(document, controller)) return;
				this.commitLoadedContent(session, loaded);
				if (document.pendingRecoveryContent !== null) {
					document.applyUserEdit(document.pendingRecoveryContent);
					document.pendingRecoveryContent = null;
					document.recovered = document.dirty;
				}
				if (runtime && this.options.getSession(session.id) === session && !session.editor) {
					session.editor = new runtime.CodeEditorController(
						session,
						this.options.getEditorSettings(),
						() => this.options.save?.(session.id),
					);
				}
			} catch (error) {
				if (isAbortError(error) || !this.#isCurrentInitialLoad(document, controller)) return;
				for (const viewId of document.viewIds) {
					const view = this.options.getSession(viewId);
					view?.editor?.dispose();
					if (view) view.editor = null;
				}
				document.loadError = error instanceof Error ? error.message : String(error);
				document.loadErrorRequiresPageReload = error instanceof ModuleImportError;
			} finally {
				if (document.loadController === controller) {
					document.loadController = null;
					document.loading = false;
				}
			}
		})();
		this.#documentLoads.set(document.id, operation);
		try {
			await operation;
		} finally {
			if (this.#documentLoads.get(document.id) === operation) {
				this.#documentLoads.delete(document.id);
			}
		}
		if (document.loadError) return;
		await Promise.all(
			[...document.viewIds].map((viewId) => {
				const view = this.options.getSession(viewId);
				return view ? this.ensureEditorForView(view) : undefined;
			}),
		);
	}

	async joinDocument(session: FileViewSession): Promise<void> {
		await this.#documentLoads.get(session.documentId);
		if (this.options.getSession(session.id) !== session) return;
		await this.ensureEditorForView(session);
	}

	async ensureEditorForView(session: FileViewSession): Promise<void> {
		const needsEditor = () =>
			this.options.getSession(session.id) === session &&
			session.rendererMode === 'code' &&
			!session.editor;
		if (!needsEditor()) return;
		try {
			const runtime = await this.#loadEditorRuntime();
			if (!needsEditor()) return;
			const recovered = session.document.editorInitializationFailed;
			session.editor = new runtime.CodeEditorController(
				session,
				this.options.getEditorSettings(),
				() => this.options.save?.(session.id),
			);
			session.document.editorInitializationFailed = false;
			if (recovered) {
				session.loadError = null;
				session.loadErrorRequiresPageReload = false;
			}
		} catch (error) {
			if (!needsEditor()) return;
			session.loadError = error instanceof Error ? error.message : String(error);
			session.loadErrorRequiresPageReload = error instanceof ModuleImportError;
			session.document.editorInitializationFailed = true;
		}
	}

	async refresh(
		sessionId: string,
		confirmDestructive: (sessionId: string) => Promise<boolean>,
	): Promise<void> {
		const session = this.options.getSession(sessionId);
		if (!session || !this.#canRefresh(session)) return;
		if (session.dirty && !(await confirmDestructive(sessionId))) return;
		if (!this.#canRefresh(session)) return;
		if (!session.loadedRevision) {
			await this.loadInitial(session);
			return;
		}

		this.invalidateFreshness(session);
		const generation = ++session.refreshGeneration;
		session.refreshController?.abort();
		const controller = new AbortController();
		session.refreshController = controller;
		const contentAtStart =
			session.contentKind === 'image' ? null : session.document.currentContent();
		this.#setRefreshing(session, true);
		session.refreshError = null;
		try {
			const loaded = await this.#readLatest(session, controller.signal);
			if (!this.#isCurrentRefresh(session, controller, generation)) return;
			if (loaded.kind === 'text' && session.document.currentContent() !== contentAtStart) {
				session.isExternallyStale = true;
				return;
			}
			this.commitLoadedContent(session, loaded);
		} catch (error) {
			if (isAbortError(error) || !this.#isCurrentRefresh(session, controller, generation)) return;
			session.refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			if (session.refreshController === controller) {
				session.refreshController = null;
				this.#setRefreshing(session, false);
			}
		}
	}

	async reload(
		sessionId: string,
		confirmDestructive: (sessionId: string) => Promise<boolean>,
	): Promise<void> {
		const session = this.options.getSession(sessionId);
		if (!session) return;
		if (session.loadError && session.loadErrorRequiresPageReload) {
			(this.options.reloadApplication ?? reloadApplication)();
			return;
		}
		if (!session.loadedRevision) {
			await this.refresh(sessionId, confirmDestructive);
			if (session.loadedRevision) {
				session.loadError = null;
				session.loadErrorRequiresPageReload = false;
			}
			return;
		}
		if (
			session.document.editorInitializationFailed &&
			session.rendererMode === 'code' &&
			!session.editor
		) {
			await this.ensureEditorForView(session);
			return;
		}
		await this.refresh(sessionId, confirmDestructive);
	}

	async checkFreshness(sessionId: string): Promise<void> {
		const session = this.options.getSession(sessionId);
		const loadedRevision = session?.loadedRevision;
		if (
			!session ||
			!loadedRevision ||
			session.loading ||
			session.refreshing ||
			session.isCheckingFreshness
		) {
			return;
		}
		const generation = ++session.freshnessGeneration;
		session.freshnessController?.abort();
		const controller = new AbortController();
		session.freshnessController = controller;
		session.isCheckingFreshness = true;
		try {
			const result = await (this.options.getFileRevision ?? getFileRevision)(
				{
					projectPath: session.canonicalFileRootPath,
					filePath: session.relativePath,
				},
				{ signal: controller.signal },
			);
			if (!this.#isCurrentFreshness(session, controller, generation, loadedRevision)) return;
			session.freshnessError = null;
			if (result.status === 'missing') {
				session.document.missing = true;
				session.isExternallyStale = true;
				return;
			}
			if (result.revision === loadedRevision) {
				session.document.missing = false;
				return;
			}
			if (!session.dirty && !session.saving && session.contentKind !== 'image') {
				const bufferVersion = session.document.bufferVersion;
				const loaded = await this.#readLatest(session, controller.signal);
				if (!this.#isCurrentFreshness(session, controller, generation, loadedRevision)) return;
				if (session.document.bufferVersion !== bufferVersion || session.dirty) {
					session.isExternallyStale = true;
					return;
				}
				this.commitLoadedContent(session, loaded);
				return;
			}
			session.document.missing = false;
			session.isExternallyStale = true;
		} catch (error) {
			if (
				isAbortError(error) ||
				!this.#isCurrentFreshness(session, controller, generation, loadedRevision)
			)
				return;
			session.freshnessError = error instanceof Error ? error.message : String(error);
		} finally {
			if (session.freshnessController === controller) {
				session.freshnessController = null;
				session.isCheckingFreshness = false;
			}
		}
	}

	async loadConflictSnapshot(session: FileViewSession): Promise<FileDiskSnapshot | null> {
		const document = session.document;
		document.conflictController?.abort();
		const controller = new AbortController();
		document.conflictController = controller;
		document.refreshError = null;
		const current = () =>
			this.options.getDocument(document.id) === document &&
			document.conflictController === controller &&
			!controller.signal.aborted;
		try {
			const result = await (this.options.readText ?? readText)(
				{
					projectPath: session.canonicalFileRootPath,
					filePath: session.relativePath,
				},
				{ signal: controller.signal },
			);
			if (!current()) return null;
			document.missing = false;
			return Object.freeze({ content: result.content, revision: result.revision });
		} catch (error) {
			if (current() && !isAbortError(error))
				document.refreshError = error instanceof Error ? error.message : String(error);
			return null;
		} finally {
			if (document.conflictController === controller) document.conflictController = null;
		}
	}

	commitLoadedContent(session: FileViewSession, loaded: LoadedFileContent): void {
		session.document.conflictController?.abort();
		session.document.conflictController = null;
		if (loaded.kind === 'image') {
			const objectUrl = URL.createObjectURL(loaded.blob);
			if (session.imageObjectUrl) URL.revokeObjectURL(session.imageObjectUrl);
			session.imageObjectUrl = objectUrl;
		} else if (session.document.editorRuntime) {
			session.document.editorRuntime.replaceFromDisk(loaded.content);
		} else {
			session.baseline = loaded.content;
			session.document.setStoredContent(loaded.content);
			Object.assign(session.document, fileTextMetadata(loaded.content));
			session.document.bufferVersion += 1;
			session.dirty = false;
			session.document.notifyChanged();
		}
		session.loadedRevision = loaded.revision;
		if (!session.document.editorInitializationFailed) {
			session.loadError = null;
			session.loadErrorRequiresPageReload = false;
		}
		session.document.missing = false;
		session.isExternallyStale = false;
		session.refreshError = null;
		session.freshnessError = null;
		session.saveError = null;
		session.document.recovered = false;
	}

	invalidateFreshness(session: FileViewSession): void {
		session.freshnessGeneration += 1;
		session.freshnessController?.abort();
		session.freshnessController = null;
		session.isCheckingFreshness = false;
	}

	async #checkDocumentFreshness(documentId: string): Promise<void> {
		const document = this.options.getDocument(documentId);
		if (!document) return;
		const view = [...document.viewIds]
			.map((viewId) => this.options.getSession(viewId))
			.filter((session): session is FileViewSession => session !== null)
			.sort((first, second) => second.lastFocusedAt - first.lastFocusedAt)[0];
		if (view) await this.checkFreshness(view.id);
	}

	async #readLatest(session: FileViewSession, signal: AbortSignal): Promise<LoadedFileContent> {
		const params = {
			projectPath: session.canonicalFileRootPath,
			filePath: session.relativePath,
		};
		if (session.contentKind === 'image') {
			const result = await (this.options.readContent ?? readContent)(params, { signal });
			return { kind: 'image', ...result };
		}
		const result = await (this.options.readText ?? readText)(params, { signal });
		return { kind: 'text', content: result.content, revision: result.revision };
	}

	#loadEditorRuntimeIfNeeded(session: FileViewSession): Promise<FileEditorRuntimeModule | null> {
		return session.rendererMode === 'code' ? this.#loadEditorRuntime() : Promise.resolve(null);
	}

	#loadEditorRuntime(): Promise<FileEditorRuntimeModule> {
		this.#editorRuntimePromise ??= (this.options.loadEditorRuntime ?? loadEditorRuntime)().catch(
			(error) => {
				this.#editorRuntimePromise = null;
				throw error;
			},
		);
		return this.#editorRuntimePromise;
	}

	#isCurrentInitialLoad(document: FileDocumentState, controller: AbortController): boolean {
		return (
			this.options.getDocument(document.id) === document &&
			!controller.signal.aborted &&
			document.loadController === controller
		);
	}

	#canRefresh(session: FileViewSession): boolean {
		return (
			this.options.getSession(session.id) === session &&
			!session.loading &&
			!session.refreshing &&
			!session.mutationGuarded
		);
	}

	#setRefreshing(session: FileViewSession, refreshing: boolean): void {
		session.refreshing = refreshing;
		this.#reconfigureViews(session.document);
	}

	#isCurrentFreshness(
		session: FileViewSession,
		controller: AbortController,
		generation: number,
		loadedRevision: FileRevision,
	): boolean {
		return (
			this.options.getDocument(session.documentId) === session.document &&
			session.loadedRevision === loadedRevision &&
			session.document.viewIds.size > 0 &&
			!controller.signal.aborted &&
			session.freshnessController === controller &&
			session.freshnessGeneration === generation
		);
	}

	#isCurrentRefresh(
		session: FileViewSession,
		controller: AbortController,
		generation: number,
	): boolean {
		return (
			this.options.getDocument(session.documentId) === session.document &&
			session.document.viewIds.size > 0 &&
			!controller.signal.aborted &&
			session.refreshController === controller &&
			session.refreshGeneration === generation
		);
	}

	#reconfigureViews(document: FileDocumentState): void {
		for (const viewId of document.viewIds) this.options.getSession(viewId)?.editor?.reconfigure();
	}
}
