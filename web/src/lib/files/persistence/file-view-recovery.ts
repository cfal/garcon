import {
	FileDocumentState,
	type FileRecoveryChoice,
} from '$lib/files/documents/file-document-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import { FileDraftOwnershipError } from '$lib/files/persistence/file-draft-repository.js';
import type {
	FileDraftRepository,
	SpaFileDraftV1,
	SpaFileViewV1,
} from '$lib/files/persistence/file-draft-repository.js';
import type { FileNavigationStore } from '$lib/files/navigation/file-navigation-store.svelte.js';
import { fileContentKind, resolveFileRendererMode } from '$lib/files/sessions/file-open-mode.js';
import { fileTextMetadata } from '$lib/files/documents/file-text-metadata.js';
import type { DesktopPlacement, PresentationHostId } from '$lib/workspace/surface-types.js';
import { createRandomId } from '$lib/utils/random-id.js';
import { SerialQueue } from '$lib/utils/serial-queue.js';

interface FileViewRecoveryOptions {
	repository: FileDraftRepository;
	deploymentId: string;
	userNamespace: string;
	browserSessionId: string;
	navigation: FileNavigationStore;
	getPlacement(sessionId: string): PresentationHostId | null;
	getRecoveryHost(): PresentationHostId;
	getSession(sessionId: string): FileViewSession | null;
	identityKey(root: string, relativePath: string): string;
	findDocument(identityKey: string): FileDocumentState | null;
	publishDocument(document: FileDocumentState, generation: number): void;
	adoptDocument(document: FileDocumentState, generation: number): void;
	persistDocument(document: FileDocumentState): Promise<void>;
	resolveDraftConflict(
		document: FileDocumentState,
		source: SpaFileDraftV1,
		choice: FileRecoveryChoice,
	): Promise<void>;
	reconfigureDocument(document: FileDocumentState): void;
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
	readonly #restoringViewIds = new Set<string>();
	readonly #recoveredCopies = new Map<string, SpaFileDraftV1>();
	readonly #operations = new SerialQueue();

	constructor(private readonly options: FileViewRecoveryOptions) {}

	resolveCopy(
		document: FileDocumentState,
		copyId: string,
		choice: FileRecoveryChoice,
	): Promise<boolean> {
		return this.#operations.enqueue(() => this.#resolveCopy(document, copyId, choice));
	}

	async #resolveCopy(
		document: FileDocumentState,
		copyId: string,
		choice: FileRecoveryChoice,
	): Promise<boolean> {
		const source = this.#recoveredCopies.get(copyId);
		if (
			!source ||
			!document.recoveredCopies.some((copy) => copy.id === copyId) ||
			document.resolvingRecovery ||
			document.recoveryGuard ||
			document.saveController ||
			document.pendingMutationCount > 0
		)
			return false;
		if (
			document.pendingSubmission &&
			source.unknownSubmission &&
			document.pendingSubmission.submissionId !== source.unknownSubmission.submissionId
		) {
			document.recoveryResolutionError = m.file_recovery_multiple_submissions();
			return false;
		}
		document.resolvingRecovery = true;
		document.recoveryResolutionError = null;
		try {
			await this.options.resolveDraftConflict(document, source, choice);
			this.#recoveredCopies.delete(copyId);
			document.recoveredCopies = document.recoveredCopies.filter((copy) => copy.id !== copyId);
			await this.options.reconcileDocument(document.id);
			return true;
		} catch (error) {
			console.error('Failed to resolve recovered file copy', error);
			document.recoveryResolutionError = m.file_recovery_resolution_failed();
			return false;
		} finally {
			document.resolvingRecovery = false;
			this.options.reconfigureDocument(document);
		}
	}

	initialize(): Promise<void> {
		return this.#operations.enqueue(() => this.#initialize());
	}

	async #initialize(): Promise<void> {
		this.options.setDiscoveryGuard(true);
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
			const retainedIds = new Set(drafts.map((draft) => draft.documentId));
			for (const [id, draft] of this.#recoveredCopies) {
				if (retainedIds.has(id)) continue;
				const owner = this.options.findDocument(
					this.options.identityKey(draft.canonicalFileRootPath, draft.normalizedRelativePath),
				);
				if (owner) owner.recoveredCopies = owner.recoveredCopies.filter((copy) => copy.id !== id);
				this.#recoveredCopies.delete(id);
			}
			await this.options.removeUnclaimedRestoredFileSurfaces(views.map((view) => view.viewId));
			const recoveredDocuments = await this.#restoreDrafts(drafts);
			await this.#restoreViews(views);
			const restorationErrors = await this.#restoreUnviewedDrafts(recoveredDocuments, views);
			await Promise.all(
				[...recoveredDocuments].map((document) => this.options.reconcileDocument(document.id)),
			);
			if (restorationErrors.length > 0) {
				throw new AggregateError(restorationErrors, m.file_recovery_incomplete());
			}
			// Failed passes retain aliases because restored view records already contain their new host.
			this.#restoredPlacements.clear();
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
		const selection = session.editor?.selectionLocation() ??
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
			updatedAt: Date.now(),
			placement,
		};
	}

	persistView(session: FileViewSession, origin?: PresentationHostId): Promise<void> {
		if (!this.#canPersistView(session)) return Promise.resolve();
		const record = this.snapshotView(session, origin);
		const operation = Promise.resolve().then(() => {
			if (!this.#canPersistView(session)) return;
			return this.persistViewSnapshot(record);
		});
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
			if (this.options.getSession(record.viewId)) continue;
			this.#restoringViewIds.add(record.viewId);
			let restored: FileViewSession | null = null;
			try {
				const key = this.options.identityKey(
					record.canonicalFileRootPath,
					record.normalizedRelativePath,
				);
				const recovered = this.options.findDocument(key);
				const originalPlacement = record.placement;
				const placement = this.#restoredPlacements.get(originalPlacement) ?? originalPlacement;
				const restoredRecord = placement === originalPlacement ? record : { ...record, placement };
				restored = await this.options.openView(
					restoredRecord,
					recovered,
					this.options.resolveRestoredPlacement(placement),
				);
				if (!restored) continue;
				this.#restoringViewIds.add(restored.id);
				const actualPlacement = this.options.getPlacement(restored.id);
				if (actualPlacement) this.#restoredPlacements.set(originalPlacement, actualPlacement);
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
				await this.options.waitForDocumentLoad(restored.documentId);
				if (this.options.getSession(restored.id) !== restored) continue;
				restored.pendingSourcePresentation = {
					selection: {
						line: record.line,
						column: record.column,
						endLine: record.endLine,
						endColumn: record.endColumn,
					},
					folds: record.folds,
				};
				await this.options.ensureEditor(restored);
				if (this.options.getSession(restored.id) !== restored) continue;
				restored.requestedLine = null;
				restored.requestedColumn = null;
				restored.editor?.restorePendingPresentation();
				this.#restoringViewIds.delete(restored.id);
				await this.options.completeViewRestoration(restored).catch(() => undefined);
			} finally {
				this.#restoringViewIds.delete(record.viewId);
				if (restored) this.#restoringViewIds.delete(restored.id);
			}
		}
	}

	async #restoreUnviewedDrafts(
		documents: ReadonlySet<FileDocumentState>,
		storedViews: readonly SpaFileViewV1[],
	): Promise<unknown[]> {
		const errors: unknown[] = [];
		for (const document of documents) {
			if (this.options.isDestroyed()) break;
			if (
				document.viewIds.size > 0 ||
				(!document.dirty && !document.saveOutcomeUnknown && document.recoveredCopies.length === 0)
			)
				continue;
			const storedView = storedViews.find(
				(view) =>
					view.canonicalFileRootPath === document.canonicalFileRootPath &&
					view.normalizedRelativePath === document.relativePath,
			);
			const record: SpaFileViewV1 = storedView ?? {
				schemaVersion: 1,
				deploymentId: this.options.deploymentId,
				userNamespace: this.options.userNamespace,
				browserSessionId: this.options.browserSessionId,
				viewId: createRandomId(),
				documentId: document.id,
				canonicalFileRootPath: document.canonicalFileRootPath,
				normalizedRelativePath: document.relativePath,
				rendererMode: resolveFileRendererMode(document.relativePath, 'auto'),
				line: 1,
				column: 1,
				endLine: 1,
				endColumn: 1,
				scrollLeft: 0,
				scrollTop: 0,
				folds: [],
				updatedAt: Date.now(),
				placement: this.options.getRecoveryHost(),
			};
			try {
				await this.#restoreViews([{ ...record, placement: this.options.getRecoveryHost() }]);
				if (
					!this.options.isDestroyed() &&
					document.viewIds.size === 0 &&
					(document.dirty || document.saveOutcomeUnknown || document.recoveredCopies.length > 0)
				) {
					errors.push(new Error(m.file_recovery_open_failed()));
				}
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}

	async #restoreDrafts(drafts: readonly SpaFileDraftV1[]): Promise<Set<FileDocumentState>> {
		const recoveredDocuments = new Set<FileDocumentState>();
		for (const storedDraft of drafts) {
			const key = this.options.identityKey(
				storedDraft.canonicalFileRootPath,
				storedDraft.normalizedRelativePath,
			);
			const existing = this.options.findDocument(key);
			if (existing) {
				await this.options.waitForDocumentLoad(existing.id);
				if (existing.recovered && storedDraft.localDocumentId === existing.id) {
					this.options.adoptDocument(existing, storedDraft.generation);
					recoveredDocuments.add(existing);
					continue;
				}
				if (
					existing.recovered ||
					(existing.dirty && existing.currentContent() !== storedDraft.content)
				) {
					await this.#retainCopy(existing, storedDraft);
					recoveredDocuments.add(existing);
					continue;
				}
				let draft: SpaFileDraftV1;
				try {
					draft = await this.options.repository.adoptDraft(storedDraft, existing.id);
				} catch (error) {
					if (!(error instanceof FileDraftOwnershipError)) throw error;
					await this.#retainCopy(existing, storedDraft);
					recoveredDocuments.add(existing);
					continue;
				}
				this.#mergeDraft(existing, draft);
				this.options.adoptDocument(existing, draft.generation);
				await this.options.persistDocument(existing);
				recoveredDocuments.add(existing);
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
			recoveredDocuments.add(document);
		}
		return recoveredDocuments;
	}

	async #retainCopy(document: FileDocumentState, draft: SpaFileDraftV1): Promise<void> {
		this.#recoveredCopies.set(draft.documentId, draft);
		document.recoveredCopies = [
			...document.recoveredCopies.filter((copy) => copy.id !== draft.documentId),
			{
				id: draft.documentId,
				content: draft.content,
				savedAt: draft.savedAt,
				hasUnknownSubmission: draft.unknownSubmission !== null,
			},
		];
		document.recovered = true;
		await this.options.persistDocument(document);
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

	async #drainWrites(viewId: string): Promise<void> {
		let pending = this.#pendingWrites.get(viewId);
		while (pending?.size) {
			await Promise.allSettled([...pending]);
			pending = this.#pendingWrites.get(viewId);
		}
	}

	#canPersistView(session: FileViewSession): boolean {
		return (
			this.options.getSession(session.id) === session &&
			!this.#closingViewIds.has(session.id) &&
			!this.#restoringViewIds.has(session.id)
		);
	}
}
