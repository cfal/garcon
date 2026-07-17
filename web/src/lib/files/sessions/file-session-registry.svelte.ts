import { ApiError } from '$lib/api/client.js';
import {
	getFileRevision,
	readContent,
	readText,
	resolveFileIdentity,
	saveText,
} from '$lib/api/files.js';
import {
	CodeEditorController,
	type EditorPresentationSettings,
} from '$lib/files/editor/code-editor-controller.svelte.js';
import { FileSession, type FileRendererMode } from '$lib/files/sessions/file-session.svelte.js';
import { fileExtension, isImageFilePath } from '$lib/utils/file-kind.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { SerialQueue } from '$lib/utils/serial-queue.js';
import type { DesktopPlacement } from '$lib/workspace/surface-types.js';
import type {
	CanonicalFileIdentity,
	FileIdentityResponse,
	FileRevision,
	FileRevisionResponse,
	FileSaveConflictResolution,
} from '$shared/file-contracts';

export type FileOpenMode = 'auto' | 'code' | 'markdown' | 'image';
export type FilePlacementResult = 'placed' | 'cancelled';

export interface FileOpenRequest {
	fileRootPath: string;
	relativePath: string;
	mode: FileOpenMode;
	target?: DesktopPlacement;
	reason: 'user-open' | 'responsive-restore';
	line?: number;
	col?: number;
}

export interface FilePlacementPort {
	placeFileSession(
		sessionId: string,
		target: DesktopPlacement | undefined,
		publication: { publish(): void; rollback(): void },
	): Promise<FilePlacementResult>;
	focusFileSession(sessionId: string): Promise<void>;
}

export interface FileGuardRequest {
	sessionId: string;
	fileName: string;
	reason: 'close' | 'replace-dialog' | 'refresh';
}

export interface FileOverwriteRequest {
	sessionId: string;
	fileName: string;
}

export type FileThresholdChoice = 'open' | 'review' | 'cancel';

export interface FileThresholdRequest {
	identity: CanonicalFileIdentity;
	resolve: (value: FileThresholdChoice) => void;
}

export interface FileSessionsDeps {
	getIsMobile(): boolean;
	getEditorSettings(): Omit<EditorPresentationSettings, 'isDark'>;
	getDefaultPlacement(mode: FileRendererMode): DesktopPlacement;
	getPlacement(): FilePlacementPort;
	onOpenError?(request: FileOpenRequest, error: unknown): void;
	resolveFileIdentity?: typeof resolveFileIdentity;
	getFileRevision?: typeof getFileRevision;
	readText?: typeof readText;
	readContent?: typeof readContent;
	saveText?: typeof saveText;
	openMainInert?<T>(commitOpen: () => T): T;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
export const FILE_SESSION_SOFT_LIMIT = 32;

type LoadedFileContent =
	| { kind: 'text'; content: string; revision: FileRevision }
	| { kind: 'image'; blob: Blob; revision: FileRevision };

export function fileIdentityKey(root: string, relativePath: string): string {
	return JSON.stringify([root, relativePath]);
}

function rendererMode(path: string, requested: FileOpenMode): FileRendererMode {
	if (requested !== 'auto') return requested;
	if (isImageFilePath(path)) return 'image';
	const ext = fileExtension(path);
	if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
	return 'code';
}

export class FileSessionRegistry {
	sessions = $state.raw<Readonly<Record<string, FileSession>>>({});
	guardRequest = $state<FileGuardRequest | null>(null);
	overwriteRequest = $state<FileOverwriteRequest | null>(null);
	thresholdRequest = $state<FileThresholdRequest | null>(null);
	openFilesVisible = $state(false);

	#sessionIdByIdentity = new Map<string, string>();
	#pendingByIdentity = new Map<string, Promise<FileSession | null>>();
	#guardResolve: ((choice: 'save' | 'discard' | 'cancel') => void) | null = null;
	#overwriteResolve: ((choice: 'overwrite' | 'cancel') => void) | null = null;
	#creationQueue = new SerialQueue();
	#decisionQueue = new SerialQueue();
	#isDark = false;

	constructor(private readonly deps: FileSessionsDeps) {}

	get all(): readonly FileSession[] {
		return Object.values(this.sessions);
	}

	get hasDirtySessions(): boolean {
		return this.all.some((session) => session.dirty);
	}

	get sessionCount(): number {
		return this.all.length;
	}

	get(sessionId: string): FileSession | null {
		return this.sessions[sessionId] ?? null;
	}

	setDarkTheme(isDark: boolean): void {
		if (this.#isDark === isDark) return;
		this.#isDark = isDark;
		for (const session of this.all) session.editor?.reconfigure();
	}

	async open(request: FileOpenRequest): Promise<FileSession | null> {
		let response: FileIdentityResponse;
		try {
			response = await (this.deps.resolveFileIdentity ?? resolveFileIdentity)({
				projectPath: request.fileRootPath,
				relativePath: request.relativePath,
			});
		} catch (error) {
			this.deps.onOpenError?.(request, error);
			return null;
		}
		const identity = response.identity;
		const key = fileIdentityKey(identity.canonicalFileRootPath, identity.normalizedRelativePath);
		const existingId = this.#sessionIdByIdentity.get(key);
		if (existingId) {
			const existing = this.get(existingId);
			if (!existing) return null;
			existing.requestLocation(request.line, request.col);
			existing.editor?.applyRequestedLocation();
			await this.deps.getPlacement().focusFileSession(existing.id);
			return existing;
		}
		const pending = this.#pendingByIdentity.get(key);
		if (pending) {
			const session = await pending;
			if (session) {
				session.requestLocation(request.line, request.col);
				session.editor?.applyRequestedLocation();
				await this.deps.getPlacement().focusFileSession(session.id);
			}
			return session;
		}
		const operation = this.#creationQueue.enqueue(() =>
			this.#createAndOpen(identity, key, request),
		);
		this.#pendingByIdentity.set(key, operation);
		try {
			return await operation;
		} finally {
			this.#pendingByIdentity.delete(key);
		}
	}

	async save(sessionId: string): Promise<boolean> {
		const session = this.get(sessionId);
		if (
			!session ||
			session.rendererMode === 'image' ||
			session.loading ||
			session.saving ||
			session.refreshing ||
			session.pendingMutationCount > 0 ||
			!session.loadedRevision
		) {
			return false;
		}
		const submittedContent = session.editor?.currentContent() ?? session.content;
		const controller = new AbortController();
		session.saveController = controller;
		session.saving = true;
		session.saveError = null;
		session.pendingMutationCount += 1;
		this.#invalidateFreshness(session);
		try {
			if (session.isExternallyStale) {
				if (!(await this.#confirmOverwrite(session))) return false;
				return await this.#writeSubmittedContent(
					session,
					submittedContent,
					'overwrite',
					controller.signal,
				);
			}

			try {
				return await this.#writeSubmittedContent(
					session,
					submittedContent,
					'reject',
					controller.signal,
				);
			} catch (error) {
				if (!this.#isFileRevisionConflict(error)) throw error;
				session.isExternallyStale = true;
				if (!(await this.#confirmOverwrite(session))) return false;
				return await this.#writeSubmittedContent(
					session,
					submittedContent,
					'overwrite',
					controller.signal,
				);
			}
		} catch (error) {
			if (isAbortError(error) || this.get(session.id) !== session) return false;
			session.saveError = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			if (session.saveController === controller) session.saveController = null;
			session.saving = false;
			session.pendingMutationCount -= 1;
		}
	}

	async refresh(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (
			!session ||
			session.loading ||
			session.refreshing ||
			session.saving ||
			session.pendingMutationCount > 0
		) {
			return;
		}
		if (!session.loadedRevision) {
			await this.#loadInitial(session);
			return;
		}
		if (session.dirty && !(await this.confirmDestructive(sessionId, 'refresh'))) return;
		if (!this.#canRefresh(session)) return;

		this.#invalidateFreshness(session);
		const generation = ++session.refreshGeneration;
		session.refreshController?.abort();
		const controller = new AbortController();
		session.refreshController = controller;
		const contentAtStart =
			session.contentKind === 'image'
				? null
				: (session.editor?.currentContent() ?? session.content);
		this.#setRefreshing(session, true);
		session.refreshError = null;
		try {
			const loaded = await this.#readLatest(session, controller.signal);
			if (!this.#isCurrentRefresh(session, controller, generation)) return;
			if (
				loaded.kind === 'text' &&
				(session.editor?.currentContent() ?? session.content) !== contentAtStart
			) {
				session.isExternallyStale = true;
				return;
			}
			this.#commitLoadedContent(session, loaded);
		} catch (error) {
			if (
				isAbortError(error) ||
				!this.#isCurrentRefresh(session, controller, generation)
			) {
				return;
			}
			session.refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			if (session.refreshController === controller) {
				session.refreshController = null;
				this.#setRefreshing(session, false);
			}
		}
	}

	async reload(sessionId: string): Promise<void> {
		await this.refresh(sessionId);
	}

	async checkFreshness(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (
			!session?.loadedRevision ||
			session.loading ||
			session.refreshing ||
			session.saving ||
			session.pendingMutationCount > 0 ||
			session.isCheckingFreshness ||
			session.isExternallyStale
		) {
			return;
		}

		const generation = ++session.freshnessGeneration;
		session.freshnessController?.abort();
		const controller = new AbortController();
		session.freshnessController = controller;
		session.isCheckingFreshness = true;
		try {
			const result = await (this.deps.getFileRevision ?? getFileRevision)(
				{
					projectPath: session.canonicalFileRootPath,
					filePath: session.relativePath,
				},
				{ signal: controller.signal },
			);
			if (!this.#isCurrentFreshness(session, controller, generation)) return;
			session.freshnessError = null;
			session.isExternallyStale = this.#revisionIsStale(session.loadedRevision, result);
		} catch (error) {
			if (
				isAbortError(error) ||
				!this.#isCurrentFreshness(session, controller, generation)
			) {
				return;
			}
			session.freshnessError = error instanceof Error ? error.message : String(error);
		} finally {
			if (session.freshnessController === controller) {
				session.freshnessController = null;
				session.isCheckingFreshness = false;
			}
		}
	}

	async confirmDestructive(
		sessionId: string,
		reason: FileGuardRequest['reason'],
	): Promise<boolean> {
		while (true) {
			const choice = await this.#decisionQueue.enqueue(async () => {
				const session = this.get(sessionId);
				if (!session || !session.dirty) return 'not-needed' as const;
				if (session.pendingMutationCount > 0) return 'blocked' as const;
				return new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
					this.#openMainInert(() => {
						this.#guardResolve = resolve;
						this.guardRequest = { sessionId, fileName: session.fileName, reason };
					});
				});
			});
			if (choice === 'not-needed' || choice === 'discard') return true;
			if (choice === 'blocked' || choice === 'cancel' || reason === 'refresh') return false;
			if (!(await this.save(sessionId))) return false;
			// The guard re-prompts if edits arrive while Save is in flight.
		}
	}

	resolveGuard(choice: 'save' | 'discard' | 'cancel'): void {
		const resolve = this.#guardResolve;
		this.#guardResolve = null;
		this.guardRequest = null;
		resolve?.(choice);
	}

	resolveOverwrite(choice: 'overwrite' | 'cancel'): void {
		const resolve = this.#overwriteResolve;
		this.#overwriteResolve = null;
		this.overwriteRequest = null;
		resolve?.(choice);
	}

	destroy(sessionId: string): void {
		const session = this.get(sessionId);
		if (!session) return;
		if (this.guardRequest?.sessionId === sessionId) this.resolveGuard('cancel');
		if (this.overwriteRequest?.sessionId === sessionId) this.resolveOverwrite('cancel');
		session.dispose();
		this.#sessionIdByIdentity.delete(session.identityKey);
		const next = { ...this.sessions };
		delete next[sessionId];
		this.sessions = next;
	}

	resolveThreshold(choice: FileThresholdChoice): void {
		const request = this.thresholdRequest;
		if (!request) return;
		if (choice === 'review') {
			this.openFilesVisible = true;
			return;
		}
		this.thresholdRequest = null;
		request.resolve(choice);
	}

	showOpenFiles(): void {
		this.#openMainInert(() => {
			this.openFilesVisible = true;
		});
	}

	hideOpenFiles(): void {
		this.openFilesVisible = false;
	}

	async #createAndOpen(
		identity: CanonicalFileIdentity,
		key: string,
		request: FileOpenRequest,
	): Promise<FileSession | null> {
		if (this.sessionCount >= FILE_SESSION_SOFT_LIMIT && request.reason === 'user-open') {
			const choice = await new Promise<FileThresholdChoice>((resolve) => {
				this.#openMainInert(() => {
					this.thresholdRequest = { identity, resolve };
				});
			});
			if (choice !== 'open') return null;
		}
		const session = new FileSession(identity, key);
		session.rendererMode = rendererMode(identity.normalizedRelativePath, request.mode);
		session.contentKind =
			session.rendererMode === 'image'
				? 'image'
				: MARKDOWN_EXTENSIONS.has(fileExtension(identity.normalizedRelativePath))
					? 'markdown'
					: 'text';
		session.requestLocation(request.line, request.col);
		if (session.rendererMode !== 'image') {
			session.editor = new CodeEditorController(session, this.#editorSettings());
		}
		// Publishes the session in its initial loading state so a renderer cannot attach
		// to empty content while placement waits for its first frame.
		session.loading = true;
		let published = false;
		const publish = () => {
			if (published) return;
			published = true;
			this.sessions = { ...this.sessions, [session.id]: session };
			this.#sessionIdByIdentity.set(key, session.id);
		};
		const rollback = () => {
			if (!published) return;
			published = false;
			this.#sessionIdByIdentity.delete(key);
			const next = { ...this.sessions };
			delete next[session.id];
			this.sessions = next;
		};
		let placementResult: FilePlacementResult;
		try {
			const target = this.deps.getIsMobile()
				? undefined
				: (request.target ?? this.deps.getDefaultPlacement(session.rendererMode));
			placementResult = await this.deps.getPlacement().placeFileSession(session.id, target, {
				publish,
				rollback,
			});
		} catch (error) {
			rollback();
			session.dispose();
			throw error;
		}
		if (placementResult === 'cancelled') {
			rollback();
			session.dispose();
			return null;
		}
		void this.#loadInitial(session);
		return session;
	}

	async #loadInitial(session: FileSession): Promise<void> {
		session.loadController?.abort();
		const controller = new AbortController();
		session.loadController = controller;
		session.loading = true;
		session.loadError = null;
		try {
			const loaded = await this.#readLatest(session, controller.signal);
			if (controller.signal.aborted) return;
			this.#commitLoadedContent(session, loaded);
		} catch (error) {
			if (isAbortError(error)) return;
			session.loadError = error instanceof Error ? error.message : String(error);
		} finally {
			if (session.loadController === controller) {
				session.loadController = null;
				session.loading = false;
			}
		}
	}

	async #readLatest(session: FileSession, signal: AbortSignal): Promise<LoadedFileContent> {
		const params = {
			projectPath: session.canonicalFileRootPath,
			filePath: session.relativePath,
		};
		if (session.contentKind === 'image') {
			const result = await (this.deps.readContent ?? readContent)(params, { signal });
			return { kind: 'image', ...result };
		}
		const result = await (this.deps.readText ?? readText)(params, { signal });
		return { kind: 'text', content: result.content, revision: result.revision };
	}

	#commitLoadedContent(session: FileSession, loaded: LoadedFileContent): void {
		if (loaded.kind === 'image') {
			const objectUrl = URL.createObjectURL(loaded.blob);
			if (session.imageObjectUrl) URL.revokeObjectURL(session.imageObjectUrl);
			session.imageObjectUrl = objectUrl;
		} else if (session.editor) {
			session.editor.replaceContentFromDisk(loaded.content);
		} else {
			session.baseline = loaded.content;
			session.content = loaded.content;
			session.editorState = null;
			session.dirty = false;
		}
		session.loadedRevision = loaded.revision;
		session.isExternallyStale = false;
		session.refreshError = null;
		session.freshnessError = null;
		session.saveError = null;
	}

	async #writeSubmittedContent(
		session: FileSession,
		submittedContent: string,
		conflictResolution: FileSaveConflictResolution,
		signal: AbortSignal,
	): Promise<boolean> {
		const expectedRevision = session.loadedRevision;
		if (!expectedRevision) return false;
		const result = await (this.deps.saveText ?? saveText)(
			{
				projectPath: session.canonicalFileRootPath,
				filePath: session.relativePath,
				content: submittedContent,
				expectedRevision,
				conflictResolution,
			},
			{ signal },
		);
		if (signal.aborted || this.get(session.id) !== session) return false;
		if (session.editor) session.editor.acceptBaseline(submittedContent);
		else {
			session.baseline = submittedContent;
			session.dirty = session.content !== submittedContent;
		}
		session.loadedRevision = result.revision;
		session.isExternallyStale = false;
		session.refreshError = null;
		session.freshnessError = null;
		return true;
	}

	#confirmOverwrite(session: FileSession): Promise<boolean> {
		return this.#decisionQueue.enqueue(async () => {
			if (this.get(session.id) !== session) return false;
			const choice = await new Promise<'overwrite' | 'cancel'>((resolve) => {
				this.#openMainInert(() => {
					this.#overwriteResolve = resolve;
					this.overwriteRequest = { sessionId: session.id, fileName: session.fileName };
				});
			});
			return choice === 'overwrite' && this.get(session.id) === session;
		});
	}

	#isFileRevisionConflict(error: unknown): boolean {
		return error instanceof ApiError && error.errorCode === 'FILE_REVISION_CONFLICT';
	}

	#revisionIsStale(
		loadedRevision: FileRevision,
		result: FileRevisionResponse,
	): boolean {
		return result.status === 'missing' || result.revision !== loadedRevision;
	}

	#invalidateFreshness(session: FileSession): void {
		session.freshnessGeneration += 1;
		session.freshnessController?.abort();
		session.freshnessController = null;
		session.isCheckingFreshness = false;
	}

	#canRefresh(session: FileSession): boolean {
		return (
			this.get(session.id) === session &&
			!session.loading &&
			!session.refreshing &&
			!session.saving &&
			session.pendingMutationCount === 0
		);
	}

	#setRefreshing(session: FileSession, refreshing: boolean): void {
		session.refreshing = refreshing;
		session.editor?.reconfigure();
	}

	#isCurrentFreshness(
		session: FileSession,
		controller: AbortController,
		generation: number,
	): boolean {
		return (
			this.get(session.id) === session &&
			!controller.signal.aborted &&
			session.freshnessController === controller &&
			session.freshnessGeneration === generation
		);
	}

	#isCurrentRefresh(
		session: FileSession,
		controller: AbortController,
		generation: number,
	): boolean {
		return (
			this.get(session.id) === session &&
			!controller.signal.aborted &&
			session.refreshController === controller &&
			session.refreshGeneration === generation
		);
	}

	#openMainInert<T>(commitOpen: () => T): T {
		if (this.deps.openMainInert) return this.deps.openMainInert(commitOpen);
		return commitOpen();
	}

	#editorSettings(): EditorPresentationSettings {
		const settings = this.deps.getEditorSettings();
		const getIsDark = () => this.#isDark;
		return {
			get isDark() {
				return getIsDark();
			},
			get wordWrap() {
				return settings.wordWrap;
			},
			get showLineNumbers() {
				return settings.showLineNumbers;
			},
			get fontSize() {
				return settings.fontSize;
			},
		};
	}
}
