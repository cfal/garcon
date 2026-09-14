import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import { saveText } from '$lib/api/files.js';
import type {
	FileDocumentState,
	LocalSaveSubmission,
} from '$lib/files/documents/file-document-state.svelte.js';
import type { FileDraftCoordinator } from '$lib/files/persistence/file-draft-coordinator.js';
import type { FileSaveConflictResolution, FileRevision } from '$shared/file-contracts';

export const FILE_SAVE_SOFT_TIMEOUT_MS = 30_000;

interface FileSaveCoordinatorOptions {
	saveText: typeof saveText;
	getDrafts(): FileDraftCoordinator | null;
	getSoftTimeoutMs(): number;
	reconfigure(document: FileDocumentState): void;
}

export class FileSaveCoordinator {
	constructor(private readonly options: FileSaveCoordinatorOptions) {}

	async retrySettlement(document: FileDocumentState): Promise<boolean> {
		const revision = document.settledSubmissionRevision;
		const submission = document.pendingSubmission;
		if (!revision || !submission || document.saveOutcome !== 'unknown') return false;
		document.saveOutcome = 'settling';
		try {
			const drafts = this.#requireDrafts();
			document.pendingSubmission = null;
			await drafts.acknowledge(document);
			document.settledSubmissionRevision = null;
			document.saveOutcome = 'idle';
			document.saveError = null;
			document.recoveryError = null;
			document.pendingMutationCount = Math.max(0, document.pendingMutationCount - 1);
			this.options.reconfigure(document);
			return true;
		} catch (error) {
			document.pendingSubmission = submission;
			document.saveOutcome = 'unknown';
			document.recoveryError = error instanceof Error ? error.message : String(error);
			this.options.reconfigure(document);
			return false;
		}
	}

	async submit(
		document: FileDocumentState,
		content: string,
		bufferVersion: number,
		conflictResolution: FileSaveConflictResolution,
		controller: AbortController,
		expectedRevision: FileRevision,
		retainOwnershipOnConflict = false,
	): Promise<'saved' | 'unknown'> {
		const submission: LocalSaveSubmission = {
			submissionId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${bufferVersion}`,
			resourceKey: document.identityKey,
			expectedDiskRevision: expectedRevision,
			submittedBufferVersion: bufferVersion,
			conflictIntent: conflictResolution,
			content,
			startedAt: Date.now(),
		};
		document.pendingSubmission = submission;
		try {
			const drafts = this.#requireDrafts();
			await drafts.persistSubmission(document);
		} catch (error) {
			document.pendingSubmission = null;
			throw error;
		}

		document.saveOutcome = 'saving';
		this.options.reconfigure(document);
		const request = this.#write(
			document,
			content,
			conflictResolution,
			controller.signal,
			expectedRevision,
		);
		const outcome = await this.#wait(request);
		if (outcome.type === 'saved') {
			return this.#acknowledge(document, submission, outcome.revision, controller);
		}
		if (outcome.type === 'rejected' && isDefinitiveSaveRejection(outcome.error)) {
			await this.#reject(
				document,
				submission,
				outcome.error,
				controller,
				retainOwnershipOnConflict && isFileRevisionConflict(outcome.error),
			);
			throw outcome.error;
		}

		document.saveOutcome = 'unknown';
		document.saveError = m.file_save_outcome_unknown_error();
		this.options.reconfigure(document);
		await this.options
			.getDrafts()
			?.persistSubmission(document)
			.catch(() => undefined);
		if (outcome.type === 'timeout') {
			void request.then(
				(revision) => this.#finishDetached(document, submission, revision, controller),
				(error) => this.#finishDetached(document, submission, null, controller, error),
			);
		}
		return 'unknown';
	}

	async #wait(
		request: Promise<FileRevision>,
	): Promise<
		| { type: 'saved'; revision: FileRevision }
		| { type: 'rejected'; error: unknown }
		| { type: 'timeout' }
	> {
		let timeout: ReturnType<typeof setTimeout> | null = null;
		try {
			return await Promise.race([
				request.then(
					(revision) => ({ type: 'saved' as const, revision }),
					(error) => ({ type: 'rejected' as const, error }),
				),
				new Promise<{ type: 'timeout' }>((resolve) => {
					timeout = setTimeout(() => resolve({ type: 'timeout' }), this.options.getSoftTimeoutMs());
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	async #finishDetached(
		document: FileDocumentState,
		submission: LocalSaveSubmission,
		revision: FileRevision | null,
		controller: AbortController,
		error?: unknown,
	): Promise<void> {
		if (
			document.saveController !== controller ||
			document.saveOutcome !== 'unknown' ||
			document.pendingSubmission?.submissionId !== submission.submissionId
		) {
			return;
		}
		if (revision) {
			await this.#acknowledge(document, submission, revision, controller);
			return;
		}
		if (error && isDefinitiveSaveRejection(error)) {
			await this.#reject(document, submission, error, controller);
		}
	}

	async #acknowledge(
		document: FileDocumentState,
		submission: LocalSaveSubmission,
		revision: FileRevision,
		controller: AbortController,
	): Promise<'saved' | 'unknown'> {
		if (document.pendingSubmission?.submissionId !== submission.submissionId) return 'unknown';
		document.loadedRevision = revision;
		document.missing = false;
		document.editorRuntime?.acceptBaseline(submission.content);
		if (!document.editorRuntime) {
			document.baseline = submission.content;
			document.dirty = document.currentContent() !== submission.content;
		}
		document.isExternallyStale = false;
		document.refreshError = null;
		document.freshnessError = null;
		document.saveOutcome = 'settling';
		document.pendingSubmission = null;
		try {
			const drafts = this.#requireDrafts();
			await drafts.acknowledge(document);
			document.saveOutcome = 'idle';
			document.settledSubmissionRevision = null;
			document.saveError = null;
			document.recoveryError = null;
			document.recovered = document.dirty;
			if (document.saveController === controller) document.saveController = null;
			document.pendingMutationCount = Math.max(0, document.pendingMutationCount - 1);
			this.options.reconfigure(document);
			return 'saved';
		} catch (error) {
			document.saveOutcome = 'unknown';
			document.pendingSubmission = submission;
			document.settledSubmissionRevision = revision;
			document.saveError = m.file_save_recovery_unsettled();
			document.recoveryError = error instanceof Error ? error.message : String(error);
			this.options.reconfigure(document);
			return 'unknown';
		}
	}

	async #reject(
		document: FileDocumentState,
		submission: LocalSaveSubmission,
		error: unknown,
		controller: AbortController,
		retainOwnership = false,
	): Promise<void> {
		if (document.pendingSubmission?.submissionId !== submission.submissionId) return;
		document.saveOutcome = 'settling';
		document.pendingSubmission = null;
		document.saveError = error instanceof Error ? error.message : String(error);
		try {
			const drafts = this.#requireDrafts();
			await drafts.acknowledge(document);
			document.saveOutcome = retainOwnership ? 'preparing' : 'idle';
			if (!retainOwnership) {
				if (document.saveController === controller) document.saveController = null;
				document.pendingMutationCount = Math.max(0, document.pendingMutationCount - 1);
			}
		} catch (settlementError) {
			document.saveOutcome = 'unknown';
			document.pendingSubmission = submission;
			document.recoveryError =
				settlementError instanceof Error ? settlementError.message : String(settlementError);
		}
		this.options.reconfigure(document);
	}

	#requireDrafts(): FileDraftCoordinator {
		const drafts = this.options.getDrafts();
		if (!drafts) throw new Error(m.file_recovery_uninitialized());
		return drafts;
	}

	async #write(
		document: FileDocumentState,
		content: string,
		conflictResolution: FileSaveConflictResolution,
		signal: AbortSignal,
		expectedRevision: FileRevision,
	): Promise<FileRevision> {
		const result = await this.options.saveText(
			{
				projectPath: document.canonicalFileRootPath,
				filePath: document.relativePath,
				content,
				expectedRevision,
				conflictResolution,
			},
			{ signal, timeoutMs: null },
		);
		return result.revision;
	}
}

export function isFileRevisionConflict(error: unknown): boolean {
	return error instanceof ApiError && error.errorCode === 'FILE_REVISION_CONFLICT';
}

function isDefinitiveSaveRejection(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		(error.errorCode === 'FILE_REVISION_CONFLICT' ||
			error.errorCode === 'VALIDATION_FAILED' ||
			error.status === 401)
	);
}
