import type { WorkspaceLayoutSnapshot } from './surface-types.js';
import { serializeWorkspaceLayout } from './layout-schema.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence.js';

export const WORKSPACE_PERSISTENCE_DELAY_MS = 250;

interface WorkspaceLayoutPersistenceOptions {
	windowTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
	documentTarget?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
	write?: (key: string, value: string) => void;
	onError?: (error: Error, retry: () => void) => void;
}

function defaultWrite(key: string, value: string): void {
	globalThis.localStorage.setItem(key, value);
}

export class WorkspaceLayoutPersistence {
	#pending: WorkspaceLayoutSnapshot | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#failed = false;
	#reportedFailure = false;
	#window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
	#document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
	#write: (key: string, value: string) => void;
	#onError: ((error: Error, retry: () => void) => void) | undefined;
	#pageHide = () => this.flush();
	#visibility = () => {
		if (this.#document.visibilityState === 'hidden') this.flush();
	};

	constructor(options: WorkspaceLayoutPersistenceOptions = {}) {
		this.#window = options.windowTarget ?? window;
		this.#document = options.documentTarget ?? document;
		this.#write = options.write ?? defaultWrite;
		this.#onError = options.onError;
		this.#window.addEventListener('pagehide', this.#pageHide);
		this.#document.addEventListener('visibilitychange', this.#visibility);
	}

	get hasError(): boolean {
		return this.#failed;
	}

	schedule(snapshot: WorkspaceLayoutSnapshot): void {
		this.#pending = snapshot;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		if (this.#failed) return;
		this.#timer = setTimeout(() => this.flush(), WORKSPACE_PERSISTENCE_DELAY_MS);
	}

	flush(): boolean {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		const snapshot = this.#pending;
		if (!snapshot) return true;
		try {
			this.#write(
				LOCAL_STORAGE_KEYS.workspaceLayout,
				JSON.stringify(serializeWorkspaceLayout(snapshot)),
			);
			this.#pending = null;
			this.#failed = false;
			this.#reportedFailure = false;
			return true;
		} catch (error) {
			this.#failed = true;
			if (!this.#reportedFailure) {
				this.#reportedFailure = true;
				const cause = error instanceof Error ? error : new Error(String(error));
				this.#onError?.(cause, () => this.retry());
			}
			return false;
		}
	}

	retry(): boolean {
		this.#failed = false;
		this.#reportedFailure = false;
		return this.flush();
	}

	destroy(): void {
		this.flush();
		this.#window.removeEventListener('pagehide', this.#pageHide);
		this.#document.removeEventListener('visibilitychange', this.#visibility);
	}
}
