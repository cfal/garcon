import * as m from '$lib/paraglide/messages.js';
import {
	getFileRevision,
	readContent,
	readText,
	resolveFileIdentity,
	saveText,
} from '$lib/api/files.js';
import type { EditorPresentationSettings } from '$lib/files/editor/code-editor-controller.svelte.js';
import {
	rendererThemeIdFor,
	type RendererThemeId,
	type ThemeRendererPresentation,
} from '$lib/theme/themes.js';
import {
	FileViewSession,
	type FileRendererMode,
} from '$lib/files/sessions/file-view-session.svelte.js';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import {
	createFileDraftRepository,
	type FileDraftRepository,
	type FileDraft,
} from '$lib/files/persistence/file-draft-repository.js';
import { FileDraftCoordinator } from '$lib/files/persistence/file-draft-coordinator.svelte.js';
import {
	FileDocumentIoCoordinator,
	type FileDiskSnapshot,
	type FileEditorRuntimeModule,
} from '$lib/files/persistence/file-document-io-coordinator.js';
import {
	FILE_SAVE_TIMEOUT_MS,
	FileSaveCoordinator,
	isFileRevisionConflict,
} from '$lib/files/persistence/file-save-coordinator.js';
import { FileNavigationStore } from '$lib/files/navigation/file-navigation-store.svelte.js';
import {
	canSaveFileChanges,
	canSubmitFileWrite,
} from '$lib/files/persistence/file-write-policy.js';
import {
	fileContentKind,
	navigationViewPreference,
	resolveFileRendererMode,
	type FileOpenMode,
} from '$lib/files/sessions/file-open-mode.js';
import {
	FileCloseCoordinator,
	type FileCloseRelease,
	type FileDestructiveReason,
} from '$lib/files/sessions/file-close-coordinator.js';
import { FileIdentityTeardownQueue } from '$lib/files/sessions/file-identity-teardown-queue.js';
import { SerialQueue } from '$lib/utils/serial-queue.js';
import type { DesktopPlacement, PresentationHostId } from '$lib/workspace/surface-types.js';
import type {
	CanonicalFileIdentity,
	FileIdentityResponse,
	FileRevision,
} from '$shared/file-contracts';

export type { FileOpenMode };
export type FilePlacementResult = 'placed' | 'cancelled';

export interface FileOpenRequest {
	fileRootPath: string;
	relativePath: string;
	mode: FileOpenMode;
	origin: PresentationHostId;
	target?: DesktopPlacement;
	reason: 'user-open' | 'responsive-restore';
	openToSide?: boolean;
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
	reason: FileDestructiveReason;
}

export interface FileOverwriteRequest {
	sessionId: string;
	fileName: string;
	baseContent: string;
	localContent: string;
	diskContent: string;
	diskRevision: FileRevision;
	localBufferVersion: number;
	lineSeparator: '\n' | '\r' | '\r\n';
}

type FileConflictChoice = 'save-checked' | 'accept-disk' | 'cancel';

interface FileConflictDecision {
	choice: FileConflictChoice;
	snapshot: FileOverwriteRequest;
	resolvedContent: string;
}

export type FileThresholdChoice = 'open' | 'cancel';

export interface FileThresholdRequest {
	identity: CanonicalFileIdentity;
	resolve: (value: FileThresholdChoice) => void;
}

export interface FileSessionsDeps {
	getIsMobile(): boolean;
	getEditorSettings(): Omit<EditorPresentationSettings, 'editorThemeId'>;
	getDefaultPlacement(mode: FileRendererMode, origin: PresentationHostId): DesktopPlacement;
	getPlacement(): FilePlacementPort;
	onOpenError?(request: FileOpenRequest, error: unknown): void;
	onRecoveryError?(document: FileDocumentState, error: Error): void;
	resolveFileIdentity?: typeof resolveFileIdentity;
	getFileRevision?: typeof getFileRevision;
	readText?: typeof readText;
	readContent?: typeof readContent;
	saveText?: typeof saveText;
	loadEditorRuntime?: () => Promise<FileEditorRuntimeModule>;
	reloadApplication?: () => void;
	openMainInert?<T>(commitOpen: () => T): T;
	draftRepository?: FileDraftRepository;
	deploymentId?: string;
	isDocumentVisible?(documentId: string): boolean;
	saveTimeoutMs?: number;
}

export type { FileEditorRuntimeModule };

export const FILE_SESSION_SOFT_LIMIT = 32;
export { FILE_SAVE_TIMEOUT_MS };

export function fileIdentityKey(root: string, relativePath: string): string {
	return JSON.stringify([root, relativePath]);
}

export class FileSessionRegistry {
	sessions = $state.raw<Readonly<Record<string, FileViewSession>>>({});
	documents = $state.raw<Readonly<Record<string, FileDocumentState>>>({});
	guardRequest = $state<FileGuardRequest | null>(null);
	overwriteRequest = $state<FileOverwriteRequest | null>(null);
	thresholdRequest = $state<FileThresholdRequest | null>(null);
	draftRequest = $state<{ fileName: string } | null>(null);

	#documentIdByIdentity = new Map<string, string>();
	#pendingByIdentity = new Map<string, Promise<FileViewSession | null>>();
	readonly #teardowns = new FileIdentityTeardownQueue();
	readonly #close = new FileCloseCoordinator((viewId) => this.get(viewId));
	#guardResolve: ((choice: 'save' | 'discard' | 'cancel') => void) | null = null;
	#overwriteResolve: ((decision: FileConflictDecision) => void) | null = null;
	#creationQueue = new SerialQueue();
	#decisionQueue = new SerialQueue();
	#editorThemeId: RendererThemeId = 'standard-light';
	readonly #draftRepository: FileDraftRepository;
	#drafts = $state.raw<FileDraftCoordinator | null>(null);
	#draftResolve: ((choice: 'resume' | 'discard' | 'cancel') => void) | null = null;
	readonly #io: FileDocumentIoCoordinator;
	readonly #saves: FileSaveCoordinator;
	readonly #deploymentId: string;
	#userNamespace: string | null = null;
	#initialization: Promise<void> = Promise.resolve();
	#destroyed = false;
	navigation = $state.raw<FileNavigationStore | null>(null);

	constructor(private readonly deps: FileSessionsDeps) {
		this.#draftRepository = deps.draftRepository ?? createFileDraftRepository();
		this.#deploymentId =
			deps.deploymentId ?? (typeof location === 'undefined' ? 'local' : location.origin);
		this.#io = new FileDocumentIoCoordinator({
			getSession: (sessionId) => this.get(sessionId),
			getDocument: (documentId) => this.documents[documentId] ?? null,
			getEditorSettings: () => this.#editorSettings(),
			save: (sessionId) => {
				void this.save(sessionId);
			},
			getFileRevision: deps.getFileRevision,
			readText: deps.readText,
			readContent: deps.readContent,
			loadEditorRuntime: deps.loadEditorRuntime,
			reloadApplication: deps.reloadApplication,
			isDocumentVisible: (documentId) => deps.isDocumentVisible?.(documentId) ?? true,
		});
		this.#saves = new FileSaveCoordinator({
			saveText: deps.saveText ?? saveText,
			getTimeoutMs: () => deps.saveTimeoutMs ?? FILE_SAVE_TIMEOUT_MS,
		});
	}

	get all(): readonly FileViewSession[] {
		return Object.values(this.sessions);
	}

	get hasUnloadProtectedSessions(): boolean {
		return Object.values(this.documents).some((document) => document.dirty || document.saving);
	}

	get recoveredDrafts(): readonly FileDraft[] {
		return this.#drafts?.available ?? [];
	}

	get recoveryError(): string | null {
		return this.#drafts?.error ?? null;
	}

	reloadApplication(): void {
		if (this.hasUnloadProtectedSessions) return;
		(this.deps.reloadApplication ?? (() => window.location.reload()))();
	}

	get sessionCount(): number {
		return this.all.length;
	}

	get(sessionId: string): FileViewSession | null {
		return this.sessions[sessionId] ?? null;
	}

	ready(): Promise<void> {
		return this.#initialization;
	}

	initializeRecovery(userNamespace: string): Promise<void> {
		if (this.#userNamespace === userNamespace) return this.#initialization;
		if (this.#userNamespace !== null) throw new Error('File recovery is already initialized');
		this.#userNamespace = userNamespace;
		const drafts = new FileDraftCoordinator({
			repository: this.#draftRepository,
			deploymentId: this.#deploymentId,
			userNamespace,
			onError: this.deps.onRecoveryError,
		});
		this.#drafts = drafts;
		this.navigation = new FileNavigationStore(this.#draftRepository, {
			deploymentId: this.#deploymentId,
			userNamespace,
		});
		this.#initialization = Promise.all([
			drafts.initialize(),
			this.navigation.restore().catch(() => undefined),
		]).then(() => this.#pruneOpenDrafts());
		return this.#initialization;
	}

	setThemePresentation(presentation: ThemeRendererPresentation): void {
		const editorThemeId = rendererThemeIdFor(presentation);
		if (this.#editorThemeId === editorThemeId) return;
		this.#editorThemeId = editorThemeId;
		for (const session of this.all) session.editor?.reconfigure();
	}

	async open(request: FileOpenRequest): Promise<FileViewSession | null> {
		await this.#initialization;
		if (this.#destroyed) return null;
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
		await this.#teardowns.drain(key);
		if (this.#destroyed) return null;
		const documentId = this.#documentIdByIdentity.get(key);
		const existingId =
			!request.openToSide && documentId ? this.#mostRecentViewId(documentId) : undefined;
		if (existingId) {
			const existing = this.get(existingId);
			if (!existing) return null;
			existing.requestLocation(request.line, request.col);
			await this.deps.getPlacement().focusFileSession(existing.id);
			this.#recordNavigation(existing);
			if (!existing.loading && !existing.loadedRevision && !existing.loadErrorRequiresPageReload) {
				await this.reload(existing.id);
			}
			return existing;
		}
		const pending = request.openToSide ? null : this.#pendingByIdentity.get(key);
		if (pending) {
			const session = await pending;
			if (session) {
				session.requestLocation(request.line, request.col);
				await this.deps.getPlacement().focusFileSession(session.id);
				this.#recordNavigation(session);
			}
			return session;
		}
		const operation = this.#creationQueue.enqueue(() =>
			this.#createAndOpen(identity, key, request),
		);
		if (!request.openToSide) {
			this.#pendingByIdentity.set(key, operation);
		}
		try {
			return await operation;
		} finally {
			if (this.#pendingByIdentity.get(key) === operation) this.#pendingByIdentity.delete(key);
		}
	}

	async save(sessionId: string): Promise<boolean> {
		const session = this.get(sessionId);
		const revision = session?.loadedRevision;
		if (!session || !revision || !canSaveFileChanges(session)) return false;
		const content = session.document.currentContent();
		const controller = this.#beginSave(session.document);
		try {
			if (session.isExternallyStale)
				return await this.#resolveConflictAndSubmit(session, controller);
			try {
				await this.#saves.submit(session.document, content, controller, revision);
				return true;
			} catch (error) {
				if (!isFileRevisionConflict(error)) throw error;
				session.isExternallyStale = true;
				return await this.#resolveConflictAndSubmit(session, controller);
			}
		} catch (error) {
			session.saveError = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			this.#finishSave(session.document, controller);
		}
	}

	#beginSave(document: FileDocumentState): AbortController {
		const controller = new AbortController();
		document.saveController = controller;
		document.saving = true;
		document.saveError = null;
		return controller;
	}

	#finishSave(document: FileDocumentState, controller: AbortController): void {
		if (document.saveController !== controller) return;
		document.saveController = null;
		document.saving = false;
		void this.#drafts?.settle(document);
	}

	async refresh(sessionId: string): Promise<void> {
		const current = this.get(sessionId);
		if (!current || current.loading || !(await this.#prepareDraftRecovery(current.document)))
			return;
		await this.#io.refresh(sessionId, (id) => this.confirmDestructive(id, 'refresh'));
		const session = this.get(sessionId);
		if (session) this.#completeDraftRecovery(session);
	}

	async reload(sessionId: string): Promise<void> {
		const current = this.get(sessionId);
		if (!current || current.loading || !(await this.#prepareDraftRecovery(current.document)))
			return;
		await this.#io.reload(sessionId, (id) => this.confirmDestructive(id, 'refresh'));
		const session = this.get(sessionId);
		if (session) this.#completeDraftRecovery(session);
	}

	checkFreshness(sessionId: string): Promise<void> {
		return this.#io.checkFreshness(sessionId);
	}

	confirmDestructive(sessionId: string, reason: FileDestructiveReason): Promise<boolean> {
		return this.confirmDestructiveViews([sessionId], reason);
	}

	async confirmDestructiveViews(
		sessionIds: readonly string[],
		reason: FileDestructiveReason,
	): Promise<boolean> {
		return this.#close.confirm(sessionIds, reason, (session, candidateReason) =>
			this.#confirmDocumentDestructive(session, candidateReason),
		);
	}

	prepareDestructiveViews(
		sessionIds: readonly string[],
		reason: Exclude<FileDestructiveReason, 'refresh'>,
	): Promise<FileCloseRelease | null> {
		return this.#close.prepare(sessionIds, reason, (session, candidateReason) =>
			this.#confirmDocumentDestructive(session, candidateReason),
		);
	}

	async #confirmDocumentDestructive(
		session: FileViewSession,
		reason: FileGuardRequest['reason'],
	): Promise<boolean> {
		while (true) {
			const version = session.document.bufferVersion;
			const choice = await this.#decisionQueue.enqueue(async () => {
				if (this.get(session.id) !== session) return 'not-needed' as const;
				if (session.document.mutationGuarded) return 'blocked' as const;
				if (!session.dirty) return 'not-needed' as const;
				return new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
					this.#openMainInert(() => {
						this.#guardResolve = resolve;
						this.guardRequest = { sessionId: session.id, fileName: session.fileName, reason };
					});
				});
			});
			if (choice === 'not-needed') return true;
			if (
				choice === 'blocked' ||
				choice === 'cancel' ||
				(reason === 'refresh' && choice === 'save')
			)
				return false;
			if (choice === 'discard') {
				if (session.document.bufferVersion !== version) continue;
				session.document.editorRuntime?.replaceFromDisk(session.baseline);
				if (!session.document.editorRuntime) session.content = session.baseline;
				session.dirty = false;
				const discardedVersion = session.document.bufferVersion;
				void this.#drafts?.settle(session.document);
				return (
					this.get(session.id) === session &&
					session.document.bufferVersion === discardedVersion &&
					!session.dirty &&
					!session.document.mutationGuarded
				);
			}
			if (!(await this.save(session.id))) return false;
		}
	}

	resolveGuard(choice: 'save' | 'discard' | 'cancel'): void {
		const resolve = this.#guardResolve;
		this.#guardResolve = null;
		this.guardRequest = null;
		resolve?.(choice);
	}

	resolveOverwrite(choice: FileConflictChoice, resolvedContent?: string): void {
		const resolve = this.#overwriteResolve;
		const snapshot = this.overwriteRequest;
		this.#overwriteResolve = null;
		this.overwriteRequest = null;
		if (!resolve || !snapshot) return;
		resolve({ choice, snapshot, resolvedContent: resolvedContent ?? snapshot.localContent });
	}

	async destroy(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (!session) return;
		await this.#teardowns.run(session.identityKey, () => this.#destroySession(session));
	}

	#destroySession(session: FileViewSession): void {
		const sessionId = session.id;
		if (this.get(sessionId) !== session) return;
		if (this.guardRequest?.sessionId === sessionId) this.resolveGuard('cancel');
		if (this.overwriteRequest?.sessionId === sessionId) this.resolveOverwrite('cancel');
		const document = session.document;
		session.dispose();
		const next = { ...this.sessions };
		delete next[sessionId];
		this.sessions = next;
		if (document.viewIds.size > 0) return;
		this.#disposeDocument(document);
	}

	#disposeDocument(document: FileDocumentState): void {
		if (this.documents[document.id] === document) {
			this.#drafts?.closeDocument(document);
			this.#io.stopPolling(document.id);
			if (this.#documentIdByIdentity.get(document.identityKey) === document.id) {
				this.#documentIdByIdentity.delete(document.identityKey);
			}
			const documents = { ...this.documents };
			delete documents[document.id];
			this.documents = documents;
		}
		document.dispose();
	}

	async destroyAll(): Promise<void> {
		this.#destroyed = true;
		this.resolveDraft('cancel');
		this.resolveThreshold('cancel');
		for (const session of [...this.all]) await this.destroy(session.id);
		for (const document of Object.values(this.documents)) this.#disposeDocument(document);
		this.#io.destroy();
		this.#drafts?.destroy();
	}

	async openToSide(
		sessionId: string,
		anchorWindowId: `window-${string}`,
	): Promise<FileViewSession | null> {
		const session = this.get(sessionId);
		if (!session) return null;
		return this.open({
			fileRootPath: session.canonicalFileRootPath,
			relativePath: session.relativePath,
			mode: session.rendererMode,
			origin: anchorWindowId,
			target: { type: 'new-window', anchorWindowId },
			reason: 'user-open',
			openToSide: true,
		});
	}

	resolveThreshold(choice: FileThresholdChoice): void {
		const request = this.thresholdRequest;
		if (!request) return;
		this.thresholdRequest = null;
		request.resolve(choice);
	}

	async #createAndOpen(
		identity: CanonicalFileIdentity,
		key: string,
		request: FileOpenRequest,
	): Promise<FileViewSession | null> {
		if (this.#destroyed) return null;
		if (this.sessionCount >= FILE_SESSION_SOFT_LIMIT && request.reason === 'user-open') {
			const choice = await new Promise<FileThresholdChoice>((resolve) => {
				this.#openMainInert(() => {
					this.thresholdRequest = { identity, resolve };
				});
			});
			if (choice !== 'open') return null;
		}
		await this.#teardowns.drain(key);
		if (this.#destroyed) return null;
		const existingDocumentId = this.#documentIdByIdentity.get(key);
		let existingDocument = existingDocumentId ? this.documents[existingDocumentId] : null;
		let document = existingDocument ?? new FileDocumentState(identity, key);
		if (!(await this.#prepareDraftRecovery(document)) || this.#destroyed) return null;
		if (existingDocument && this.documents[document.id] !== document) {
			const pendingRecoveryContent = document.pendingRecoveryContent;
			document = new FileDocumentState(identity, key);
			document.pendingRecoveryContent = pendingRecoveryContent;
			existingDocument = null;
		}
		const session = new FileViewSession(document);
		session.rendererMode = resolveFileRendererMode(identity.normalizedRelativePath, request.mode);
		if (!existingDocument) {
			document.contentKind = fileContentKind(identity.normalizedRelativePath, session.rendererMode);
			document.loading = true;
		}
		session.requestLocation(request.line, request.col);
		let published = false;
		let rolledBack = false;
		const publish = () => {
			if (published || rolledBack || this.#destroyed) return;
			published = true;
			this.sessions = { ...this.sessions, [session.id]: session };
			if (!existingDocument) this.#publishDocument(document);
			else if (document.loadedRevision) void this.#io.ensureEditorForView(session);
		};
		const rollback = () => {
			if (rolledBack) return;
			rolledBack = true;
			if (published) this.#destroySession(session);
			else {
				session.dispose();
				if (document.viewIds.size === 0) this.#disposeDocument(document);
			}
		};
		let placementResult: FilePlacementResult;
		try {
			const target = this.deps.getIsMobile()
				? undefined
				: (request.target ?? this.deps.getDefaultPlacement(session.rendererMode, request.origin));
			const placement = this.deps.getPlacement();
			placementResult = await placement.placeFileSession(session.id, target, { publish, rollback });
		} catch (error) {
			rollback();
			if (this.#destroyed) return null;
			throw error;
		}
		if (placementResult === 'cancelled' || this.#destroyed || this.get(session.id) !== session) {
			rollback();
			return null;
		}
		if (existingDocument && document.loadedRevision) {
			void this.#io.joinDocument(session);
		} else {
			void this.#io.loadInitial(session).then(() => this.#completeDraftRecovery(session));
		}
		this.#io.startPolling(document.id);
		this.#recordNavigation(session);
		return session;
	}

	async showConflict(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (!session || session.document.mutationGuarded) return;
		const disk = await this.#io.loadConflictSnapshot(session);
		if (!disk) return;
		const decision = await this.#confirmConflict(session, disk);
		if (decision.choice !== 'save-checked' || !canSubmitFileWrite(session)) return;
		this.#applyConflictResolution(session, decision);
		const controller = this.#beginSave(session.document);
		try {
			await this.#saves.submit(
				session.document,
				decision.resolvedContent,
				controller,
				decision.snapshot.diskRevision,
			);
		} catch (error) {
			session.saveError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#finishSave(session.document, controller);
		}
	}

	resolveDraft(choice: 'resume' | 'discard' | 'cancel'): void {
		const resolve = this.#draftResolve;
		this.#draftResolve = null;
		this.draftRequest = null;
		resolve?.(choice);
	}

	#prepareDraftRecovery(document: FileDocumentState): Promise<boolean> {
		if (
			document.loading ||
			document.loadedRevision ||
			document.dirty ||
			document.pendingRecoveryContent !== null ||
			!this.#drafts?.find(document.canonicalFileRootPath, document.relativePath)
		)
			return Promise.resolve(true);
		return this.#decisionQueue.enqueue(async () => {
			if (this.#destroyed) return false;
			if (document.loadedRevision || document.dirty || document.pendingRecoveryContent !== null)
				return true;
			const draft = this.#drafts?.find(document.canonicalFileRootPath, document.relativePath);
			if (!draft) return true;
			const choice = await new Promise<'resume' | 'discard' | 'cancel'>((resolve) => {
				this.#openMainInert(() => {
					this.#draftResolve = resolve;
					this.draftRequest = { fileName: document.relativePath };
				});
			});
			if (choice === 'cancel' || this.#destroyed) return false;
			if (choice === 'resume') document.pendingRecoveryContent = draft.content;
			else this.#drafts?.discard(draft);
			return true;
		});
	}

	async retryRecoveryDiscovery(): Promise<void> {
		await this.#drafts?.initialize();
		this.#pruneOpenDrafts();
	}

	#pruneOpenDrafts(): void {
		// Live buffers take precedence over startup backups, except a Resume still awaiting disk.
		for (const document of Object.values(this.documents)) {
			if (document.pendingRecoveryContent !== null || (!document.loadedRevision && !document.dirty))
				continue;
			this.#drafts?.opened(document.canonicalFileRootPath, document.relativePath);
			void this.#drafts?.settle(document);
		}
	}

	#completeDraftRecovery(session: FileViewSession): void {
		if (
			session.loadError ||
			!session.loadedRevision ||
			session.document.pendingRecoveryContent !== null
		)
			return;
		if (!this.#drafts?.find(session.canonicalFileRootPath, session.relativePath)) return;
		this.#drafts.opened(session.canonicalFileRootPath, session.relativePath);
		void this.#drafts.settle(session.document);
	}

	async clearRecovery(): Promise<boolean> {
		if (this.hasUnloadProtectedSessions) return false;
		const cleared = (await this.#drafts?.clear()) ?? false;
		if (cleared) {
			for (const document of Object.values(this.documents)) document.pendingRecoveryContent = null;
		}
		return cleared;
	}

	async exportContent(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (session) this.#download(session.document.currentContent(), session.fileName);
	}

	exportDraft(documentId: string): void {
		const draft = this.recoveredDrafts.find((entry) => entry.documentId === documentId);
		if (draft)
			this.#download(draft.content, draft.normalizedRelativePath.split('/').pop() ?? 'draft.txt');
	}

	#download(content: string, fileName: string): void {
		const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
		try {
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = fileName;
			anchor.click();
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	async #resolveConflictAndSubmit(
		session: FileViewSession,
		controller: AbortController,
	): Promise<boolean> {
		const disk = await this.#io.loadConflictSnapshot(session);
		if (!disk) return false;
		const decision = await this.#confirmConflict(session, disk, true);
		if (decision.choice !== 'save-checked') return false;
		this.#applyConflictResolution(session, decision);
		await this.#saves.submit(
			session.document,
			decision.resolvedContent,
			controller,
			decision.snapshot.diskRevision,
		);
		return true;
	}

	#confirmConflict(
		session: FileViewSession,
		disk: FileDiskSnapshot,
		allowOwnedMutation = false,
	): Promise<FileConflictDecision> {
		return this.#decisionQueue.enqueue(async () => {
			const snapshot: FileOverwriteRequest = {
				sessionId: session.id,
				fileName: session.fileName,
				baseContent: session.baseline,
				localContent: session.document.currentContent(),
				diskContent: disk.content,
				diskRevision: disk.revision,
				localBufferVersion: session.document.bufferVersion,
				lineSeparator: session.document.lineSeparator,
			};
			const cancelled = (): FileConflictDecision => ({
				choice: 'cancel',
				snapshot,
				resolvedContent: snapshot.localContent,
			});
			const canResolve = () =>
				this.get(session.id) === session &&
				(allowOwnedMutation || !session.document.mutationGuarded);
			if (!canResolve()) return cancelled();
			const decision = await new Promise<FileConflictDecision>((resolve) => {
				this.#openMainInert(() => {
					this.#overwriteResolve = resolve;
					this.overwriteRequest = snapshot;
				});
			});
			if (decision.choice !== 'cancel' && !canResolve()) {
				session.saveError = m.file_conflict_buffer_changed();
				return cancelled();
			}
			if (decision.choice === 'accept-disk') {
				if (session.document.bufferVersion !== decision.snapshot.localBufferVersion) {
					session.saveError = m.file_conflict_buffer_changed();
					return cancelled();
				}
				this.#io.commitLoadedContent(session, {
					kind: 'text',
					content: decision.snapshot.diskContent,
					revision: decision.snapshot.diskRevision,
				});
				void this.#drafts?.settle(session.document);
			}
			return this.get(session.id) === session ? decision : cancelled();
		});
	}

	#applyConflictResolution(session: FileViewSession, decision: FileConflictDecision): void {
		if (session.document.bufferVersion !== decision.snapshot.localBufferVersion) {
			return;
		}
		if (decision.resolvedContent !== session.document.currentContent()) {
			session.document.applyUserEdit(decision.resolvedContent);
		}
	}

	#mostRecentViewId(documentId: string): string | undefined {
		return this.all
			.filter((session) => session.documentId === documentId)
			.sort((first, second) => second.lastFocusedAt - first.lastFocusedAt)[0]?.id;
	}

	#recordNavigation(session: FileViewSession): void {
		const selection = session.editor?.selectionLocation();
		this.navigation?.record({
			key: session.identityKey,
			canonicalFileRootPath: session.canonicalFileRootPath,
			normalizedRelativePath: session.relativePath,
			displayPath: session.relativePath,
			revision: session.loadedRevision,
			line: session.requestedLine ?? selection?.line ?? 1,
			column: session.requestedColumn ?? selection?.column ?? 1,
			viewPreference: navigationViewPreference(session.rendererMode),
			timestamp: Date.now(),
		});
	}

	flushRecovery(): Promise<void> {
		return this.#drafts?.flush() ?? Promise.resolve();
	}

	viewVisibilityChanged(sessionId: string): void {
		const session = this.get(sessionId);
		if (session) this.#io.visibilityChanged(session.documentId);
	}

	async showSource(sessionId: string): Promise<boolean> {
		const session = this.get(sessionId);
		if (!session || session.contentKind === 'image') return false;
		session.markdownMode = 'source';
		session.rendererMode = 'code';
		await this.#io.ensureEditorForView(session);
		return Boolean(session.editor);
	}

	#publishDocument(document: FileDocumentState): void {
		this.documents = { ...this.documents, [document.id]: document };
		this.#documentIdByIdentity.set(document.identityKey, document.id);
		document.onChange(() => {
			this.#drafts?.schedule(document);
		});
	}

	#openMainInert<T>(commitOpen: () => T): T {
		if (this.deps.openMainInert) return this.deps.openMainInert(commitOpen);
		return commitOpen();
	}

	#editorSettings(): EditorPresentationSettings {
		const settings = this.deps.getEditorSettings();
		const getEditorThemeId = () => this.#editorThemeId;
		return {
			get editorThemeId() {
				return getEditorThemeId();
			},
			get wordWrap() {
				return settings.wordWrap;
			},
			get vimMode() {
				return settings.vimMode;
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
