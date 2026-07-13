import { apiFetch } from '$lib/api/client.js';
import { getContentUrl, readText, resolveFileIdentity, saveText } from '$lib/api/files.js';
import {
	CodeEditorController,
	type EditorPresentationSettings,
} from '$lib/components/files/code-editor-controller.svelte.js';
import { FileSession, type FileRendererMode } from '$lib/components/files/file-session.svelte.js';
import type { HostId } from '$lib/workspace/surface-types.js';
import type { CanonicalFileIdentity } from '$shared/file-contracts';
import * as m from '$lib/paraglide/messages.js';

export type FileOpenMode = 'auto' | 'code' | 'markdown' | 'image';

export interface FileOpenRequest {
	chatId?: string | null;
	fileRootPath: string;
	relativePath: string;
	mode: FileOpenMode;
	target?: HostId | 'dialog';
	reason: 'user-open' | 'responsive-restore';
	line?: number;
	col?: number;
}

export interface FilePlacementPort {
	placeFileSession(
		sessionId: string,
		target: HostId | 'dialog' | undefined,
		publication: { publish(): void; rollback(): void },
	): Promise<boolean>;
	focusFileSession(sessionId: string): Promise<void>;
}

export interface FileGuardRequest {
	sessionId: string;
	fileName: string;
	reason: 'close' | 'replace-dialog';
}

export type FileThresholdChoice = 'open' | 'review' | 'cancel';

export interface FileThresholdRequest {
	identity: CanonicalFileIdentity;
	resolve: (value: FileThresholdChoice) => void;
}

export interface FileSessionsDeps {
	getIsMobile(): boolean;
	getEditorSettings(): EditorPresentationSettings;
	getPlacement(): FilePlacementPort;
	resolveFileIdentity?: typeof resolveFileIdentity;
	readText?: typeof readText;
	saveText?: typeof saveText;
	fetchContent?: typeof apiFetch;
	openMainInert?<T>(commitOpen: () => T): T;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

export function fileIdentityKey(root: string, relativePath: string): string {
	return JSON.stringify([root, relativePath]);
}

function extension(path: string): string {
	const fileName = path.split('/').pop() ?? path;
	return fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';
}

function rendererMode(path: string, requested: FileOpenMode): FileRendererMode {
	if (requested !== 'auto') return requested;
	const ext = extension(path);
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
	return 'code';
}

export class FileSessionRegistry {
	sessions = $state.raw<Readonly<Record<string, FileSession>>>({});
	guardRequest = $state<FileGuardRequest | null>(null);
	thresholdRequest = $state<FileThresholdRequest | null>(null);
	openFilesVisible = $state(false);

	#sessionIdByIdentity = new Map<string, string>();
	#pendingByIdentity = new Map<string, Promise<FileSession | null>>();
	#guardResolve: ((choice: 'save' | 'discard' | 'cancel') => void) | null = null;
	#creationTail: Promise<void> = Promise.resolve();
	#guardTail: Promise<void> = Promise.resolve();

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

	async open(request: FileOpenRequest): Promise<FileSession | null> {
		const response = await (this.deps.resolveFileIdentity ?? resolveFileIdentity)({
			chatId: request.chatId,
			projectPath: request.chatId ? null : request.fileRootPath,
			relativePath: request.relativePath,
		});
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
		const operation = this.#enqueueCreation(() => this.#createAndOpen(identity, key, request));
		this.#pendingByIdentity.set(key, operation);
		try {
			return await operation;
		} finally {
			this.#pendingByIdentity.delete(key);
		}
	}

	async save(sessionId: string): Promise<boolean> {
		const session = this.get(sessionId);
		if (!session || session.rendererMode === 'image' || session.saving) return false;
		const submittedContent = session.content;
		session.saving = true;
		session.saveError = null;
		session.pendingMutationCount += 1;
		try {
			await (this.deps.saveText ?? saveText)({
				projectPath: session.canonicalFileRootPath,
				filePath: session.relativePath,
				content: submittedContent,
			});
			session.baseline = submittedContent;
			session.dirty = session.content !== submittedContent;
			return true;
		} catch (error) {
			session.saveError = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			session.saving = false;
			session.pendingMutationCount -= 1;
		}
	}

	async reload(sessionId: string): Promise<void> {
		const session = this.get(sessionId);
		if (!session || session.dirty || session.pendingMutationCount > 0) return;
		await this.#load(session);
	}

	async confirmDestructive(
		sessionId: string,
		reason: FileGuardRequest['reason'],
	): Promise<boolean> {
		return this.#enqueueGuard(async () => {
			const session = this.get(sessionId);
			if (!session) return true;
			if (session.pendingMutationCount > 0) return false;
			if (!session.dirty) return true;
			const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
				this.#openMainInert(() => {
					this.#guardResolve = resolve;
					this.guardRequest = { sessionId, fileName: session.fileName, reason };
				});
			});
			if (choice === 'cancel') return false;
			if (choice === 'save') return this.save(sessionId);
			return true;
		});
	}

	resolveGuard(choice: 'save' | 'discard' | 'cancel'): void {
		const resolve = this.#guardResolve;
		this.#guardResolve = null;
		this.guardRequest = null;
		resolve?.(choice);
	}

	destroy(sessionId: string): void {
		const session = this.get(sessionId);
		if (!session) return;
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
		if (this.sessionCount >= 32 && request.reason === 'user-open') {
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
				: MARKDOWN_EXTENSIONS.has(extension(identity.normalizedRelativePath))
					? 'markdown'
					: 'text';
		session.requestLocation(request.line, request.col);
		if (session.rendererMode !== 'image') {
			session.editor = new CodeEditorController(session, this.deps.getEditorSettings());
		}
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
		let placed: boolean;
		try {
			placed = await this.deps
				.getPlacement()
				.placeFileSession(session.id, this.deps.getIsMobile() ? undefined : request.target, {
					publish,
					rollback,
				});
		} catch (error) {
			rollback();
			session.dispose();
			throw error;
		}
		if (!placed) {
			rollback();
			session.dispose();
			return null;
		}
		void this.#load(session);
		return session;
	}

	#enqueueCreation(operation: () => Promise<FileSession | null>): Promise<FileSession | null> {
		let resolveResult: (session: FileSession | null) => void;
		let rejectResult: (error: unknown) => void;
		const result = new Promise<FileSession | null>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const turn = this.#creationTail.then(async () => {
			try {
				resolveResult(await operation());
			} catch (error) {
				rejectResult(error);
			}
		});
		this.#creationTail = turn.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #load(session: FileSession): Promise<void> {
		session.loadController?.abort();
		const controller = new AbortController();
		session.loadController = controller;
		session.loading = true;
		session.loadError = null;
		try {
			if (session.rendererMode === 'image') {
				const response = await (this.deps.fetchContent ?? apiFetch)(
					getContentUrl({
						projectPath: session.canonicalFileRootPath,
						filePath: session.relativePath,
					}),
					{ signal: controller.signal },
				);
				if (!response.ok) {
					throw new Error(m.file_session_content_request_failed({ status: response.status }));
				}
				const objectUrl = URL.createObjectURL(await response.blob());
				if (controller.signal.aborted) {
					URL.revokeObjectURL(objectUrl);
					return;
				}
				session.imageObjectUrl = objectUrl;
				return;
			}
			const data = await (this.deps.readText ?? readText)(
				{
					projectPath: session.canonicalFileRootPath,
					filePath: session.relativePath,
				},
				{ signal: controller.signal },
			);
			if (controller.signal.aborted) return;
			const content = data.content ?? '';
			session.baseline = content;
			session.content = content;
			session.editorState = null;
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') return;
			session.loadError = error instanceof Error ? error.message : String(error);
		} finally {
			if (session.loadController === controller) {
				session.loadController = null;
				session.loading = false;
			}
		}
	}

	#enqueueGuard(operation: () => Promise<boolean>): Promise<boolean> {
		let resolveResult: (allowed: boolean) => void;
		let rejectResult: (error: unknown) => void;
		const result = new Promise<boolean>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const turn = this.#guardTail.then(async () => {
			try {
				resolveResult(await operation());
			} catch (error) {
				rejectResult(error);
			}
		});
		this.#guardTail = turn.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#openMainInert<T>(commitOpen: () => T): T {
		if (this.deps.openMainInert) return this.deps.openMainInert(commitOpen);
		return commitOpen();
	}
}
