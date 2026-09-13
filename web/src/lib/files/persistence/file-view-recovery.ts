import { ApiError } from '$lib/api/client.js';
import type { FileIdentityResponse } from '$shared/file-contracts';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import type {
	FileDraftRepository,
	SpaFileDraftV1,
	SpaFileViewV1,
} from '$lib/files/persistence/file-draft-repository.js';
import type { FileNavigationStore } from '$lib/files/navigation/file-navigation-store.svelte.js';
import { fileContentKind, resolveFileRendererMode } from '$lib/files/sessions/file-open-mode.js';
import { fileTextMetadata } from '$lib/files/documents/file-text-metadata.js';
import type { DesktopPlacement, PresentationHostId } from '$lib/workspace/surface-types.js';

interface FileViewRecoveryOptions {
	repository: FileDraftRepository;
	deploymentId: string;
	userNamespace: string;
	browserSessionId: string;
	navigation: FileNavigationStore;
	getPlacement(sessionId: string): PresentationHostId | null;
	getSession(sessionId: string): FileViewSession | null;
	resolveIdentity(input: {
		projectPath: string;
		relativePath: string;
	}): Promise<FileIdentityResponse>;
	identityKey(root: string, relativePath: string): string;
	findDocument(identityKey: string): FileDocumentState | null;
	publishDocument(document: FileDocumentState, generation: number): void;
	adoptDocument(document: FileDocumentState, generation: number): void;
	persistDocument(document: FileDocumentState): Promise<void>;
	openView(
		record: SpaFileViewV1,
		document: FileDocumentState | null,
		target?: DesktopPlacement,
	): Promise<FileViewSession | null>;
	completeViewRestoration(session: FileViewSession): Promise<void>;
	resolveRestoredPlacement(host: PresentationHostId): DesktopPlacement | undefined;
	removeUnclaimedRestoredFileSurfaces(viewIds: readonly string[]): Promise<void>;
	ensureEditor(session: FileViewSession): Promise<void>;
	waitForDocumentLoad(documentId: string): Promise<void>;
	reconcileDocument(documentId: string): Promise<void>;
	pollDocument(documentId: string): void;
	isDestroyed(): boolean;
	setDiscoveryGuard(guarded: boolean, error?: string): void;
}

export class FileViewRecovery {
	readonly #restoredPlacements = new Map<PresentationHostId, PresentationHostId>();
	readonly #pendingWrites = new Map<string, Set<Promise<void>>>();
	readonly #closingViewIds = new Set<string>();

	constructor(private readonly options: FileViewRecoveryOptions) {}

	async initialize(): Promise<void> {
		this.options.setDiscoveryGuard(true);
		this.#restoredPlacements.clear();
		try {
			const [drafts, views] = await Promise.all([
				this.options.repository.getDrafts(
					this.options.userNamespace,
					this.options.deploymentId,
					this.options.browserSessionId,
				),
				this.options.repository.getViews(
					this.options.userNamespace,
					this.options.deploymentId,
					this.options.browserSessionId,
				),
				this.options.navigation.restore(),
			]);
			if (this.options.isDestroyed()) return;
			await this.options.removeUnclaimedRestoredFileSurfaces(views.map((view) => view.viewId));
			const recoveredDocumentIds = await this.#restoreDrafts(drafts);
			await this.#restoreViews(views);
			await Promise.all(
				[...recoveredDocumentIds].map((documentId) => this.options.reconcileDocument(documentId)),
			);
			this.options.setDiscoveryGuard(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.setDiscoveryGuard(true, message);
		}
	}

	snapshotView(session: FileViewSession, origin?: PresentationHostId): SpaFileViewV1 {
		const placement = this.options.getPlacement(session.id) ?? origin ?? 'dialog';
		const requestedSelection = session.requestedLine
			? {
					line: session.requestedLine,
					column: session.requestedColumn ?? 1,
					endLine: session.requestedLine,
					endColumn: session.requestedColumn ?? 1,
				}
			: null;
		const selection =
			session.editor?.selectionLocation() ??
			requestedSelection ??
			session.pendingSourcePresentation?.selection ?? {
				line: 1,
				column: 1,
				endLine: 1,
				endColumn: 1,
			};
		return {
			schemaVersion: 1,
			deploymentId: this.options.deploymentId,
			userNamespace: this.options.userNamespace,
			browserSessionId: this.options.browserSessionId,
			viewId: session.id,
			documentId: session.documentId,
			canonicalFileRootPath: session.canonicalFileRootPath,
			normalizedRelativePath: session.relativePath,
			rendererMode: session.rendererMode,
			...selection,
			scrollLeft: session.textScrollLeft,
			scrollTop: session.textScrollTop,
			markdownScrollLeft: session.markdownScrollLeft,
			markdownScrollTop: session.markdownScrollTop,
			imageMode: session.image.mode,
			imageScale: session.image.scale,
			imageScrollLeft: session.image.scrollLeft,
			imageScrollTop: session.image.scrollTop,
			folds: session.editor?.folds() ?? session.pendingSourcePresentation?.folds ?? [],
			pinned: session.pinned,
			preview: session.preview,
			updatedAt: Date.now(),
			placement,
		};
	}

	persistView(session: FileViewSession, origin?: PresentationHostId): Promise<void> {
		if (this.#closingViewIds.has(session.id)) return Promise.resolve();
		const record = this.snapshotView(session, origin);
		const operation = Promise.resolve().then(() => this.persistViewSnapshot(record));
		let pending = this.#pendingWrites.get(session.id);
		if (!pending) {
			pending = new Set();
			this.#pendingWrites.set(session.id, pending);
		}
		pending.add(operation);
		return operation.finally(() => {
			pending.delete(operation);
			if (pending.size === 0) this.#pendingWrites.delete(session.id);
		});
	}

	persistViewSnapshot(record: SpaFileViewV1): Promise<void> {
		return this.options.repository.putView(record);
	}

	prepareViewClose(session: FileViewSession, preserveView: boolean): () => Promise<void> {
		const record = preserveView ? this.snapshotView(session) : null;
		session.stopPresentationPersistence();
		this.#closingViewIds.add(session.id);
		return async () => {
			try {
				await this.#drainWrites(session.id);
				if (record) await this.persistViewSnapshot(record);
				else {
					await this.options.repository.deleteView(
						session.id,
						this.options.userNamespace,
						this.options.deploymentId,
						this.options.browserSessionId,
					);
				}
			} finally {
				this.#closingViewIds.delete(session.id);
			}
		};
	}

	async clear(documents: readonly FileDocumentState[]): Promise<boolean> {
		this.#setMutationReservation(documents, 1);
		try {
			if (documents.some((document) => document.dirty || document.saveOutcomeUnknown)) return false;
			const cleared = await this.options.repository.clearNamespaceIfUnprotected(
				this.options.userNamespace,
				this.options.deploymentId,
				this.options.browserSessionId,
			);
			if (cleared) this.options.navigation.clearLocalState();
			return cleared;
		} finally {
			this.#setMutationReservation(documents, -1);
		}
	}

	async #restoreViews(views: readonly SpaFileViewV1[]): Promise<void> {
		for (const record of [...views].sort((first, second) => first.updatedAt - second.updatedAt)) {
			if (this.options.isDestroyed()) return;
			const key = this.options.identityKey(
				record.canonicalFileRootPath,
				record.normalizedRelativePath,
			);
			const recovered = this.options.findDocument(key);
			if (recovered) await this.#probeRecoveredDocument(recovered);
			const originalPlacement = record.placement;
			const placement = this.#restoredPlacements.get(originalPlacement) ?? originalPlacement;
			const restoredRecord = placement === originalPlacement ? record : { ...record, placement };
			const restored = await this.options.openView(
				restoredRecord,
				recovered,
				this.options.resolveRestoredPlacement(placement),
			);
			if (!restored) continue;
			const actualPlacement = this.options.getPlacement(restored.id);
			if (actualPlacement) this.#restoredPlacements.set(originalPlacement, actualPlacement);
			restored.pinned = record.pinned;
			restored.preview = record.preview;
			restored.textScrollLeft = record.scrollLeft;
			restored.textScrollTop = record.scrollTop;
			restored.markdownScrollLeft = record.markdownScrollLeft ?? 0;
			restored.markdownScrollTop = record.markdownScrollTop ?? 0;
			restored.image = {
				mode: record.imageMode ?? 'fit',
				scale: record.imageScale ?? 1,
				scrollLeft: record.imageScrollLeft ?? 0,
				scrollTop: record.imageScrollTop ?? 0,
			};
			if (restored.loading) {
				await new Promise<void>((resolve) => {
					const check = () => {
						if (!restored.loading) resolve();
						else setTimeout(check, 10);
					};
					check();
				});
			}
			const sourcePresentation = {
				selection: {
					line: record.line,
					column: record.column,
					endLine: record.endLine,
					endColumn: record.endColumn,
				},
				folds: record.folds,
			};
			restored.pendingSourcePresentation = sourcePresentation;
			await this.options.ensureEditor(restored);
			restored.requestedLine = null;
			restored.requestedColumn = null;
			restored.editor?.restorePendingPresentation();
			await this.options.completeViewRestoration(restored).catch(() => undefined);
		}
	}

	async #restoreDrafts(drafts: readonly SpaFileDraftV1[]): Promise<Set<string>> {
		const recoveredDocumentIds = new Set<string>();
		for (const storedDraft of drafts) {
			const key = this.options.identityKey(
				storedDraft.canonicalFileRootPath,
				storedDraft.normalizedRelativePath,
			);
			const existing = this.options.findDocument(key);
			if (existing) {
				await this.options.waitForDocumentLoad(existing.id);
				if (existing.dirty && existing.currentContent() !== storedDraft.content) {
					throw new Error('A newer unsaved buffer must be resolved before restoring its older draft');
				}
				const draft = await this.options.repository.adoptDraft(storedDraft, existing.id);
				this.#mergeDraft(existing, draft);
				this.options.adoptDocument(existing, draft.generation);
				await this.options.persistDocument(existing);
				recoveredDocumentIds.add(existing.id);
				continue;
			}
			const localDocumentId = storedDraft.localDocumentId ?? storedDraft.documentId;
			const draft = await this.options.repository.adoptDraft(storedDraft, localDocumentId);
			const document = new FileDocumentState(
				{
					canonicalFileRootPath: draft.canonicalFileRootPath,
					normalizedRelativePath: draft.normalizedRelativePath,
				},
				key,
				localDocumentId,
			);
			document.baseline = draft.baselineContent ?? '';
			document.contentKind = fileContentKind(
				draft.normalizedRelativePath,
				resolveFileRendererMode(draft.normalizedRelativePath, 'auto'),
			);
			document.setStoredContent(draft.content);
			Object.assign(document, fileTextMetadata(draft.content));
			document.loadedRevision = draft.diskRevision;
			document.bufferVersion = draft.bufferVersion;
			document.dirty = draft.content !== document.baseline;
			document.recovered = true;
			document.pendingSubmission = draft.unknownSubmission;
			if (draft.unknownSubmission) document.saveOutcome = 'unknown';
			this.options.publishDocument(document, draft.generation);
			this.options.pollDocument(document.id);
			recoveredDocumentIds.add(document.id);
		}
		return recoveredDocumentIds;
	}

	#setMutationReservation(documents: readonly FileDocumentState[], delta: 1 | -1): void {
		for (const document of documents) {
			document.pendingMutationCount = Math.max(0, document.pendingMutationCount + delta);
			for (const viewId of document.viewIds) this.options.getSession(viewId)?.editor?.reconfigure();
		}
	}

	#mergeDraft(document: FileDocumentState, draft: SpaFileDraftV1): void {
		const current = document.currentContent();
		const baseline = draft.baselineContent ?? '';
		document.loadedRevision = draft.diskRevision;
		document.contentKind = fileContentKind(
			draft.normalizedRelativePath,
			resolveFileRendererMode(draft.normalizedRelativePath, 'auto'),
		);
		if (!document.dirty && current === document.baseline) {
			Object.assign(document, fileTextMetadata(draft.content));
			document.baseline = baseline;
			document.content = draft.content;
			document.bufferVersion = Math.max(document.bufferVersion, draft.bufferVersion);
			document.dirty = draft.content !== document.baseline;
		} else {
			document.baseline = baseline;
			document.dirty = current !== baseline;
		}
		document.recovered = true;
		if (draft.unknownSubmission) {
			document.pendingSubmission = draft.unknownSubmission;
			document.saveOutcome = 'unknown';
		}
	}

	async #probeRecoveredDocument(document: FileDocumentState): Promise<void> {
		try {
			await this.options.resolveIdentity({
				projectPath: document.canonicalFileRootPath,
				relativePath: document.relativePath,
			});
		} catch (error) {
			document.missing = error instanceof ApiError && error.status === 404;
			document.loadError = error instanceof Error ? error.message : String(error);
		}
	}

	async #drainWrites(viewId: string): Promise<void> {
		let pending = this.#pendingWrites.get(viewId);
		while (pending?.size) {
			await Promise.allSettled([...pending]);
			pending = this.#pendingWrites.get(viewId);
		}
	}
}
