import type { CanonicalFileIdentity, FileRevision } from '$shared/file-contracts';
import type { FileDestructiveReason } from './file-close-coordinator.js';
import { SerialQueue } from '$lib/utils/serial-queue.js';

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

export type FileConflictChoice = 'save-checked' | 'accept-disk' | 'cancel';

export interface FileConflictDecision {
	choice: FileConflictChoice;
	snapshot: FileOverwriteRequest;
	resolvedContent: string;
}

export type FileThresholdChoice = 'open' | 'cancel';

export interface FileThresholdRequest {
	identity: CanonicalFileIdentity;
	resolve: (value: FileThresholdChoice) => void;
}

type FileGuardChoice = 'save' | 'discard' | 'cancel';
type FileDraftChoice = 'resume' | 'discard' | 'cancel';

export class FileDialogCoordinator {
	guardRequest = $state.raw<FileGuardRequest | null>(null);
	overwriteRequest = $state.raw<FileOverwriteRequest | null>(null);
	thresholdRequest = $state.raw<FileThresholdRequest | null>(null);
	draftRequest = $state.raw<{ fileName: string } | null>(null);

	readonly #decisions = new SerialQueue();
	#guardResolve: ((choice: FileGuardChoice) => void) | null = null;
	#overwriteResolve: ((decision: FileConflictDecision) => void) | null = null;
	#draftResolve: ((choice: FileDraftChoice) => void) | null = null;

	constructor(private readonly openMainInert: <T>(commitOpen: () => T) => T) {}

	serialize<T>(decide: () => Promise<T>): Promise<T> {
		return this.#decisions.enqueue(decide);
	}

	askGuard(request: FileGuardRequest): Promise<FileGuardChoice> {
		return new Promise((resolve) => {
			this.openMainInert(() => {
				this.#guardResolve = resolve;
				this.guardRequest = request;
			});
		});
	}

	askOverwrite(snapshot: FileOverwriteRequest): Promise<FileConflictDecision> {
		return new Promise((resolve) => {
			this.openMainInert(() => {
				this.#overwriteResolve = resolve;
				this.overwriteRequest = snapshot;
			});
		});
	}

	askThreshold(identity: CanonicalFileIdentity): Promise<FileThresholdChoice> {
		return new Promise((resolve) => {
			this.openMainInert(() => {
				this.thresholdRequest = { identity, resolve };
			});
		});
	}

	askDraft(fileName: string): Promise<FileDraftChoice> {
		return new Promise((resolve) => {
			this.openMainInert(() => {
				this.#draftResolve = resolve;
				this.draftRequest = { fileName };
			});
		});
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

	resolveThreshold(choice: FileThresholdChoice): void {
		const request = this.thresholdRequest;
		if (!request) return;
		this.thresholdRequest = null;
		request.resolve(choice);
	}

	resolveDraft(choice: 'resume' | 'discard' | 'cancel'): void {
		const resolve = this.#draftResolve;
		this.#draftResolve = null;
		this.draftRequest = null;
		resolve?.(choice);
	}
}
