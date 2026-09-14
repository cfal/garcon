import type { CanonicalFileIdentity, FileRevision } from '$shared/file-contracts';
import { createRandomId } from '$lib/utils/random-id.js';

export type FileDocumentContentKind = 'text' | 'markdown' | 'image';
export type FileSaveOutcome = 'idle' | 'preparing' | 'saving' | 'settling' | 'unknown';

export interface LocalSaveSubmission {
	submissionId: string;
	resourceKey: string;
	expectedDiskRevision: string;
	submittedBufferVersion: number;
	conflictIntent: 'reject' | 'overwrite';
	content: string;
	startedAt: number;
}

export type FileRecoveryChoice = 'keep-current' | 'use-recovered';

export interface FileRecoveredCopy {
	id: string;
	content: string;
	savedAt: number;
	hasUnknownSubmission: boolean;
}

export interface FileDocumentRuntimePort {
	content(): string;
	applyUserEdit(content: string): void;
	synchronizeDocument(content: string): void;
	acceptBaseline(content: string): void;
	replaceFromDisk(content: string): void;
}

export interface FileDocumentPositionMap {
	previousPosition(line: number, column: number): number;
	mapRange(from: number, to: number): { from: number; to: number };
	nextLocation(position: number): { line: number; column: number };
}

export class FileDocumentState {
	readonly id: string;
	readonly identityKey: string;
	readonly canonicalFileRootPath: string;
	readonly relativePath: string;

	contentKind = $state<FileDocumentContentKind>('text');
	lineSeparator = $state<'\n' | '\r' | '\r\n'>('\n');
	mixedLineEndings = $state(false);
	baseline = $state('');
	#content = $state.raw('');
	dirty = $state(false);
	bufferVersion = $state(0);
	loading = $state(false);
	loadError = $state<string | null>(null);
	loadErrorRequiresPageReload = $state(false);
	editorInitializationFailed = false;
	saveOutcome = $state<FileSaveOutcome>('idle');
	saveError = $state<string | null>(null);
	isExternallyStale = $state(false);
	isCheckingFreshness = $state(false);
	refreshing = $state(false);
	refreshError = $state<string | null>(null);
	freshnessError = $state<string | null>(null);
	readOnly = $state(false);
	missing = $state(false);
	recovered = $state(false);
	recoveredCopies = $state.raw<readonly FileRecoveredCopy[]>([]);
	resolvingRecovery = $state(false);
	recoveryResolutionError = $state<string | null>(null);
	recoveryError = $state<string | null>(null);
	recoveryGuard = $state(false);
	recoveryDiscoveryError = $state<string | null>(null);
	diskContent = $state<string | null>(null);
	diskRevision = $state<FileRevision | null>(null);
	pendingSubmission = $state.raw<LocalSaveSubmission | null>(null);
	settledSubmissionRevision = $state<FileRevision | null>(null);
	pendingMutationCount = $state(0);

	loadedRevision = $state<FileRevision | null>(null);
	imageObjectUrl = $state<string | null>(null);
	loadController: AbortController | null = null;
	saveController: AbortController | null = null;
	freshnessController: AbortController | null = null;
	refreshController: AbortController | null = null;
	freshnessGeneration = 0;
	refreshGeneration = 0;
	editorRuntime: FileDocumentRuntimePort | null = null;
	readonly viewIds = new Set<string>();
	readonly #changeListeners = new Set<(positionMap?: FileDocumentPositionMap) => void>();

	constructor(identity: CanonicalFileIdentity, identityKey: string, id = createRandomId()) {
		this.id = id;
		this.identityKey = identityKey;
		this.canonicalFileRootPath = identity.canonicalFileRootPath;
		this.relativePath = identity.normalizedRelativePath;
	}

	get fileName(): string {
		return this.relativePath.split('/').pop() ?? this.relativePath;
	}

	get content(): string {
		this.bufferVersion;
		return this.editorRuntime?.content() ?? this.#content;
	}

	set content(content: string) {
		if (this.editorRuntime) {
			this.editorRuntime.synchronizeDocument(content);
			return;
		}
		if (this.#content === content) return;
		this.#content = content;
		this.bufferVersion += 1;
		this.dirty = content !== this.baseline;
		this.notifyChanged();
	}

	get saving(): boolean {
		return this.saveOutcome !== 'idle' && this.saveOutcome !== 'unknown';
	}

	get saveOutcomeUnknown(): boolean {
		return this.saveOutcome === 'unknown';
	}

	get mutationGuarded(): boolean {
		return (
			this.saveOutcomeUnknown ||
			this.recoveryGuard ||
			this.recoveredCopies.length > 0 ||
			this.resolvingRecovery ||
			this.pendingMutationCount > 0
		);
	}

	get canDiscard(): boolean {
		return !this.mutationGuarded;
	}

	currentContent(): string {
		return this.content;
	}

	applyUserEdit(content: string): void {
		if (this.editorRuntime) {
			this.editorRuntime.applyUserEdit(content);
			return;
		}
		this.content = content;
	}

	setStoredContent(content: string): void {
		this.#content = content;
	}

	onChange(listener: (positionMap?: FileDocumentPositionMap) => void): () => void {
		this.#changeListeners.add(listener);
		return () => this.#changeListeners.delete(listener);
	}

	notifyChanged(positionMap?: FileDocumentPositionMap): void {
		for (const listener of this.#changeListeners) listener(positionMap);
	}

	attachView(viewId: string): void {
		this.viewIds.add(viewId);
	}

	detachView(viewId: string): void {
		this.viewIds.delete(viewId);
	}

	dispose(): void {
		this.loadController?.abort();
		this.freshnessGeneration += 1;
		this.freshnessController?.abort();
		this.refreshGeneration += 1;
		this.refreshController?.abort();
		if (this.imageObjectUrl) URL.revokeObjectURL(this.imageObjectUrl);
		this.imageObjectUrl = null;
		this.editorRuntime = null;
		this.#changeListeners.clear();
	}
}
