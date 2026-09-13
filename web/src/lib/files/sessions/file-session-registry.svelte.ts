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
import type { FileRendererMode } from '$lib/files/sessions/file-session.svelte.js';
import { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import {
	createFileDraftRepository,
	type FileDraftRepository,
	type SpaFileViewV1,
} from '$lib/files/persistence/file-draft-repository.js';
import { FileDraftCoordinator } from '$lib/files/persistence/file-draft-coordinator.js';
import {
	FileDocumentIoCoordinator,
	type FileEditorRuntimeModule,
} from '$lib/files/persistence/file-document-io-coordinator.js';
import {
	FILE_SAVE_SOFT_TIMEOUT_MS,
	FileSaveCoordinator,
	isFileRevisionConflict,
} from '$lib/files/persistence/file-save-coordinator.js';
import { FileNavigationStore } from '$lib/files/navigation/file-navigation-store.svelte.js';
import { FileViewRecovery } from '$lib/files/persistence/file-view-recovery.js';
import { prepareRestoredView } from '$lib/files/persistence/restored-file-view.js';
import { canSubmitFileWrite } from '$lib/files/persistence/file-write-policy.js';
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
	reason: 'user-open' | 'responsive-restore' | 'restored-view';
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
	restoreFileSession?(
		sessionId: string,
		target: DesktopPlacement | undefined,
		publication: { publish(): void; rollback(): void },
	): Promise<FilePlacementResult>;
	focusFileSession(sessionId: string): Promise<void>;
	filePlacement?(sessionId: string): PresentationHostId | null;
	resolveRestoredPlacement?(host: PresentationHostId): DesktopPlacement | undefined;
	removeUnclaimedRestoredFileSurfaces?(viewIds: readonly string[]): Promise<void>;
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
	diskContent: string | null;
	diskRevision: FileRevision | null;
	localBufferVersion: number;
	lineSeparator: '\n' | '\r' | '\r\n';
}

type FileConflictChoice = 'save-checked' | 'overwrite' | 'accept-disk' | 'cancel';

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
	userNamespace?: string | null;
	browserSessionId?: string;
	isDocumentVisible?(documentId: string): boolean;
	saveSoftTimeoutMs?: number;
}

export type { FileEditorRuntimeModule };

export const FILE_SESSION_SOFT_LIMIT = 32;
export { FILE_SAVE_SOFT_TIMEOUT_MS };

export function fileIdentityKey(root: string, relativePath: string): string {
	return JSON.stringify([root, relativePath]);
}

function defaultRestoredPlacement(host: PresentationHostId): DesktopPlacement | undefined {
	if (host === 'mobile') return undefined;
	if (host === 'dialog') return { type: 'dialog' };
	return { type: 'window', windowId: host };
}

export class FileSessionRegistry {
	sessions = $state.raw<Readonly<Record<string, FileViewSession>>>({});
	documents = $state.raw<Readonly<Record<string, FileDocumentState>>>({});
	guardRequest = $state<FileGuardRequest | null>(null);
	overwriteRequest = $state<FileOverwriteRequest | null>(null);
	thresholdRequest = $state<FileThresholdRequest | null>(null);

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
	#drafts: FileDraftCoordinator | null = null;
	#viewRecovery: FileViewRecovery | null = null;
	readonly #io: FileDocumentIoCoordinator;
	readonly #saves: FileSaveCoordinator;
	readonly #deploymentId: string;
	#userNamespace: string | null = null;
	#browserSessionId: string;
	#initialization: Promise<void> = Promise.resolve();
	#recoveryDiscoveryGuarded = false;
	#recoveryDiscoveryError: string | null = null;
	#destroyed = false;
	navigation = $state.raw<FileNavigationStore | null>(null);

	constructor(private readonly deps: FileSessionsDeps) {
		this.#draftRepository = deps.draftRepository ?? createFileDraftRepository();
		this.#deploymentId =
			deps.deploymentId ?? (typeof location === 'undefined' ? 'local' : location.origin);
		this.#browserSessionId =
			deps.browserSessionId ?? globalThis.crypto?.randomUUID?.() ?? 'local-session';
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
			getDrafts: () => this.#drafts,
			getSoftTimeoutMs: () => deps.saveSoftTimeoutMs ?? FILE_SAVE_SOFT_TIMEOUT_MS,
			reconfigure: (document) => this.#reconfigureDocumentViews(document),
		});
		if (deps.userNamespace) this.initializeRecovery(deps.userNamespace);
	}

	get all(): readonly FileViewSession[] {
		return Object.values(this.sessions);
	}

	get hasDirtySessions(): boolean {
		return this.all.some((session) => session.dirty);
	}

	get hasUnloadProtectedSessions(): boolean {
		return Object.values(this.documents).some((doc) => doc.dirty || doc.saveOutcome !== 'idle');
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

	initializeRecovery(
		userNamespace: string,
		browserSessionId = this.#browserSessionId,
	): Promise<void> {
		if (this.#userNamespace === userNamespace) return this.#initialization;
		if (this.#userNamespace !== null) throw new Error('File recovery is already initialized');
		this.#userNamespace = userNamespace;
		this.#browserSessionId = browserSessionId;
		this.#drafts = new FileDraftCoordinator({
			repository: this.#draftRepository,
			deploymentId: this.#deploymentId,
			userNamespace,
			browserSessionId: this.#browserSessionId,
		});
		this.navigation = new FileNavigationStore(this.#draftRepository, {
			deploymentId: this.#deploymentId,
			userNamespace,
		});
		this.#viewRecovery = new FileViewRecovery({
			repository: this.#draftRepository,
			deploymentId: this.#deploymentId,
			userNamespace,
			browserSessionId: this.#browserSessionId,
			navigation: this.navigation,
			getPlacement: (sessionId) => this.deps.getPlacement().filePlacement?.(sessionId) ?? null,
			getSession: (sessionId) => this.get(sessionId),
			resolveIdentity: (input) => (this.deps.resolveFileIdentity ?? resolveFileIdentity)(input),
			identityKey: fileIdentityKey,
			findDocument: (key) => {
				const documentId = this.#documentIdByIdentity.get(key);
				return documentId ? (this.documents[documentId] ?? null) : null;
			},
			publishDocument: (document, generation) => {
				this.#publishDocument(document);
				this.#drafts?.adopt(document, generation);
			},
			adoptDocument: (document, generation) => this.#drafts?.adopt(document, generation),
			persistDocument: (document) => this.#drafts?.settle(document) ?? Promise.resolve(),
			openView: (record, document, target) => this.#openRestoredView(record, document, target),
			completeViewRestoration: (session) => {
				this.#enableViewPersistence(session);
				return this.#persistView(session);
			},
			resolveRestoredPlacement: (host) =>
				this.deps.getPlacement().resolveRestoredPlacement?.(host) ?? defaultRestoredPlacement(host),
			removeUnclaimedRestoredFileSurfaces: (viewIds) =>
				this.deps.getPlacement().removeUnclaimedRestoredFileSurfaces?.(viewIds) ??
				Promise.resolve(),
			ensureEditor: (session) => this.#io.ensureEditorForView(session),
			waitForDocumentLoad: (documentId) => this.#io.waitForDocumentLoad(documentId),
			reconcileDocument: (documentId) => this.#io.reconcileDocument(documentId),
			pollDocument: (documentId) => this.#io.startPolling(documentId),
			isDestroyed: () => this.#destroyed,
			setDiscoveryGuard: (guarded, error = '') => {
				this.#recoveryDiscoveryGuarded = guarded;
				this.#recoveryDiscoveryError = error || null;
				for (const document of Object.values(this.documents)) {
					document.recoveryGuard = guarded;
					document.recoveryDiscoveryError = this.#recoveryDiscoveryError;
					this.#reconfigureDocumentViews(document);
				}
			},
		});
		this.#initialization = this.#viewRecovery.initialize();
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
			void this.#persistView(existing).catch(() => undefined);
			return existing;
		}
		const pending =
			request.openToSide || request.reason === 'restored-view'
				? null
				: this.#pendingByIdentity.get(key);
		if (pending) {
			const session = await pending;
			if (session) {
				session.requestLocation(request.line, request.col);
				await this.deps.getPlacement().focusFileSession(session.id);
				this.#recordNavigation(session);
				void this.#persistView(session).catch(() => undefined);
			}
			return session;
		}
		const operation = this.#creationQueue.enqueue(() =>
			this.#createAndOpen(identity, key, request),
		);
		if (!request.openToSide && request.reason !== 'restored-view') {
			this.#pendingByIdentity.set(key, operation);
		}
		try {
			return await operation;
		} finally {
			if (this.#pendingByIdentity.get(key) === operation) this.#pendingByIdentity.delete(key);
		}
	}

	async save(sessionId: string): Promise<boolean> {
		await this.#initialization;
		const session = this.get(sessionId);
		if (!session) return false;
		const expectedRevision = session.loadedRevision;
		if (!expectedRevision || !canSubmitFileWrite(session) || !session.dirty) return false;
		const submittedContent = session.document.currentContent();
		const submittedBufferVersion = session.document.bufferVersion;
		const controller = new AbortController();
		let requestDetached = false;
		session.saveController = controller;
		session.document.saveOutcome = 'preparing';
		session.saveError = null;
		session.pendingMutationCount += 1;
		this.#io.invalidateFreshness(session);
		this.#reconfigureDocumentViews(session.document);
		try {
			if (session.isExternallyStale) {
				await this.#io.loadConflictSnapshot(session);
				const decision = await this.#confirmConflict(session, true);
				if (decision.choice === 'cancel' || decision.choice === 'accept-disk') {
					session.saveError = null;
					return false;
				}
				const resolvedBufferVersion = this.#applyConflictResolution(session, decision);
				const outcome = await this.#saves.submit(
					session.document,
					decision.resolvedContent,
					resolvedBufferVersion,
					decision.choice === 'overwrite' ? 'overwrite' : 'reject',
					controller,
					decision.snapshot.diskRevision ?? expectedRevision,
				);
				requestDetached = outcome === 'unknown';
				return outcome === 'saved';
			}

			try {
				const outcome = await this.#saves.submit(
					session.document,
					submittedContent,
					submittedBufferVersion,
					'reject',
					controller,
					expectedRevision,
					true,
				);
				requestDetached = outcome === 'unknown';
				return outcome === 'saved';
			} catch (error) {
				if (!isFileRevisionConflict(error)) throw error;
				session.isExternallyStale = true;
				await this.#io.loadConflictSnapshot(session);
				const decision = await this.#confirmConflict(session, true);
				if (decision.choice === 'cancel' || decision.choice === 'accept-disk') {
					session.saveError = null;
					return false;
				}
				const resolvedBufferVersion = this.#applyConflictResolution(session, decision);
				const outcome = await this.#saves.submit(
					session.document,
					decision.resolvedContent,
					resolvedBufferVersion,
					decision.choice === 'overwrite' ? 'overwrite' : 'reject',
					controller,
					decision.snapshot.diskRevision ?? expectedRevision,
				);
				requestDetached = outcome === 'unknown';
				return outcome === 'saved';
			}
		} catch (error) {
			if (this.get(session.id) !== session && session.document.viewIds.size === 0) return false;
			session.saveError = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			if (!requestDetached) {
				if (session.saveController === controller) session.saveController = null;
				if (!session.saveOutcomeUnknown) session.document.saveOutcome = 'idle';
				session.pendingMutationCount = Math.max(0, session.pendingMutationCount - 1);
				this.#reconfigureDocumentViews(session.document);
			}
		}
	}

	async refresh(sessionId: string): Promise<void> {
		return this.#io.refresh(sessionId, (id) => this.confirmDestructive(id, 'refresh'));
	}

	async reload(sessionId: string): Promise<void> {
		await this.#io.reload(sessionId, (id) => this.confirmDestructive(id, 'refresh'));
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
				await this.#drafts?.clear(session.document);
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

	async destroy(sessionId: string, preserveView = false): Promise<void> {
		const session = this.get(sessionId);
		if (!session) return;
		await this.#teardowns.run(session.identityKey, () =>
			this.#destroySession(session, preserveView),
		);
	}

	async #destroySession(session: FileViewSession, preserveView: boolean): Promise<void> {
		const sessionId = session.id;
		if (this.get(sessionId) !== session) return;
		if (this.guardRequest?.sessionId === sessionId) this.resolveGuard('cancel');
		if (this.overwriteRequest?.sessionId === sessionId) this.resolveOverwrite('cancel');
		const document = session.document;
		const finishViewClose = this.#viewRecovery?.prepareViewClose(session, preserveView);
		session.dispose();
		const next = { ...this.sessions };
		delete next[sessionId];
		this.sessions = next;
		await finishViewClose?.().catch(() => undefined);
		if (document.viewIds.size > 0) return;
		await this.#drafts?.closeDocument(document).catch(() => undefined);
		this.#io.stopPolling(document.id);
		this.#documentIdByIdentity.delete(document.identityKey);
		const documents = { ...this.documents };
		delete documents[document.id];
		this.documents = documents;
		document.dispose();
	}

	async destroyAll(): Promise<void> {
		this.#destroyed = true;
		for (const session of [...this.all]) await this.destroy(session.id, true);
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
		viewId?: string,
	): Promise<FileViewSession | null> {
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
		const existingDocument = existingDocumentId ? this.documents[existingDocumentId] : null;
		const document = existingDocument ?? new FileDocumentState(identity, key);
		const session = new FileViewSession(document, viewId);
		if (request.reason !== 'restored-view') this.#enableViewPersistence(session);
		session.rendererMode = resolveFileRendererMode(identity.normalizedRelativePath, request.mode);
		if (!existingDocument) {
			document.contentKind = fileContentKind(identity.normalizedRelativePath, session.rendererMode);
			document.loading = true;
		}
		session.requestLocation(request.line, request.col);
		let published = false;
		const publish = () => {
			if (published) return;
			published = true;
			this.sessions = { ...this.sessions, [session.id]: session };
			if (!existingDocument) this.#publishDocument(document);
			else void this.#io.ensureEditorForView(session);
		};
		const rollback = () => {
			if (!published) return;
			published = false;
			session.dispose();
			const next = { ...this.sessions };
			delete next[session.id];
			this.sessions = next;
			if (!existingDocument) {
				this.#documentIdByIdentity.delete(key);
				const documents = { ...this.documents };
				delete documents[document.id];
				this.documents = documents;
			}
		};
		let placementResult: FilePlacementResult;
		try {
			const target = this.deps.getIsMobile()
				? undefined
				: (request.target ?? this.deps.getDefaultPlacement(session.rendererMode, request.origin));
			const placement = this.deps.getPlacement();
			const place =
				request.reason === 'restored-view' && placement.restoreFileSession
					? placement.restoreFileSession.bind(placement)
					: placement.placeFileSession.bind(placement);
			placementResult = await place(session.id, target, {
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
		if (existingDocument) {
			void this.#io.joinDocument(session);
		} else {
			void this.#io.loadInitial(session);
		}
		this.#io.startPolling(document.id);
		if (request.reason !== 'restored-view') this.#recordNavigation(session);
		if (request.reason !== 'restored-view') {
			void this.#persistView(session, request.origin).catch(() => undefined);
		}
		return session;
	}

	async showConflict(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (!session || session.document.mutationGuarded) return;
		await this.#io.loadConflictSnapshot(session);
		if (session.document.diskContent === null || !session.document.diskRevision) return;
		const decision = await this.#confirmConflict(session);
		if (decision.choice === 'cancel' || decision.choice === 'accept-disk') return;
		if (!canSubmitFileWrite(session)) return;
		const resolvedBufferVersion = this.#applyConflictResolution(session, decision);
		const controller = new AbortController();
		session.saveController = controller;
		session.document.saveOutcome = 'preparing';
		session.pendingMutationCount += 1;
		this.#reconfigureDocumentViews(session.document);
		let detached = false;
		try {
			const outcome = await this.#saves.submit(
				session.document,
				decision.resolvedContent,
				resolvedBufferVersion,
				decision.choice === 'overwrite' ? 'overwrite' : 'reject',
				controller,
				decision.snapshot.diskRevision!,
			);
			detached = outcome === 'unknown';
		} catch (error) {
			session.saveError = error instanceof Error ? error.message : String(error);
		} finally {
			if (!detached) {
				if (session.saveController === controller) session.saveController = null;
				if (!session.saveOutcomeUnknown) session.document.saveOutcome = 'idle';
				session.pendingMutationCount = Math.max(0, session.pendingMutationCount - 1);
				this.#reconfigureDocumentViews(session.document);
			}
		}
	}

	retryRecoveryDiscovery(): Promise<void> {
		if (!this.#viewRecovery) return Promise.resolve();
		this.#initialization = this.#viewRecovery.initialize();
		return this.#initialization;
	}

	retrySaveSettlement(sessionId: string): Promise<boolean> {
		const session = this.get(sessionId);
		return session ? this.#saves.retrySettlement(session.document) : Promise.resolve(false);
	}

	async clearRecovery(): Promise<boolean> {
		return this.#viewRecovery?.clear(Object.values(this.documents)) ?? false;
	}

	async exportContent(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (!session || typeof document === 'undefined') return;
		const blob = new Blob([session.document.currentContent()], {
			type: 'text/plain;charset=utf-8',
		});
		const url = URL.createObjectURL(blob);
		try {
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = session.fileName;
			anchor.click();
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	#confirmConflict(
		session: FileViewSession,
		allowOwnedMutation = false,
	): Promise<FileConflictDecision> {
		return this.#decisionQueue.enqueue(async () => {
			const snapshot: FileOverwriteRequest = {
				sessionId: session.id,
				fileName: session.fileName,
				baseContent: session.baseline,
				localContent: session.document.currentContent(),
				diskContent: session.document.diskContent,
				diskRevision: session.document.diskRevision,
				localBufferVersion: session.document.bufferVersion,
				lineSeparator: session.document.lineSeparator,
			};
			const cancelled = (): FileConflictDecision => ({
				choice: 'cancel',
				snapshot,
				resolvedContent: snapshot.localContent,
			});
			if (
				this.get(session.id) !== session ||
				(!allowOwnedMutation && session.document.mutationGuarded) ||
				session.saveOutcomeUnknown ||
				session.document.recoveryGuard
			) {
				return cancelled();
			}
			const decision = await new Promise<FileConflictDecision>((resolve) => {
				this.#openMainInert(() => {
					this.#overwriteResolve = resolve;
					this.overwriteRequest = snapshot;
				});
			});
			if (
				decision.choice === 'accept-disk' &&
				session.document.bufferVersion !== decision.snapshot.localBufferVersion
			) {
				session.saveError =
					'The buffer changed while the comparison was open. Review it again before accepting disk.';
				return cancelled();
			}
			if (
				decision.choice === 'accept-disk' &&
				!session.saveOutcomeUnknown &&
				!session.document.recoveryGuard &&
				decision.snapshot.diskContent !== null &&
				decision.snapshot.diskRevision
			) {
				this.#io.commitLoadedContent(session, {
					kind: 'text',
					content: decision.snapshot.diskContent,
					revision: decision.snapshot.diskRevision,
				});
				await this.#drafts?.clear(session.document);
			}
			return this.get(session.id) === session ? decision : cancelled();
		});
	}

	#applyConflictResolution(session: FileViewSession, decision: FileConflictDecision): number {
		if (session.document.bufferVersion !== decision.snapshot.localBufferVersion) {
			return decision.snapshot.localBufferVersion;
		}
		if (decision.resolvedContent !== session.document.currentContent()) {
			session.document.applyUserEdit(decision.resolvedContent);
		}
		return session.document.bufferVersion;
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

	async persistView(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (session) await this.#persistView(session);
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
		await this.#persistView(session);
		return Boolean(session.editor);
	}

	async #persistView(session: FileViewSession, origin?: PresentationHostId): Promise<void> {
		await this.#viewRecovery?.persistView(session, origin);
	}

	#enableViewPersistence(session: FileViewSession): void {
		session.onPresentationChanged = () => {
			void this.#persistView(session).catch(() => undefined);
		};
	}

	async #openRestoredView(
		record: SpaFileViewV1,
		recovered: FileDocumentState | null,
		target?: DesktopPlacement,
	): Promise<FileViewSession | null> {
		const prepared = await prepareRestoredView(
			record,
			recovered,
			(input) => (this.deps.resolveFileIdentity ?? resolveFileIdentity)(input),
			fileIdentityKey,
			target,
		);
		const key = fileIdentityKey(
			prepared.identity.canonicalFileRootPath,
			prepared.identity.normalizedRelativePath,
		);
		if (prepared.document && !this.#documentIdByIdentity.has(key)) {
			this.#publishDocument(prepared.document);
		}
		return this.#creationQueue.enqueue(() =>
			this.#createAndOpen(prepared.identity, key, prepared.request, record.viewId),
		);
	}

	#publishDocument(document: FileDocumentState): void {
		document.recoveryGuard = this.#recoveryDiscoveryGuarded;
		document.recoveryDiscoveryError = this.#recoveryDiscoveryError;
		this.documents = { ...this.documents, [document.id]: document };
		this.#documentIdByIdentity.set(document.identityKey, document.id);
		document.onChange(() => {
			this.#drafts?.schedule(document);
		});
	}

	#reconfigureDocumentViews(document: FileDocumentState): void {
		for (const viewId of document.viewIds) this.get(viewId)?.editor?.reconfigure();
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
