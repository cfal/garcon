import type { ChatSessionRecord } from '$lib/types/chat-session';

export type ProjectPathChangedListener = (chatId: string, projectPath: string | null) => void;

export class ChatProjectBindingState {
	readonly #revisions = new Map<string, number>();
	readonly #listeners = new Set<ProjectPathChangedListener>();

	captureRevisions(): ReadonlyMap<string, number> {
		return new Map(this.#revisions);
	}

	revision(chatId: string): number {
		return this.#revisions.get(chatId) ?? 0;
	}

	subscribe(listener: ProjectPathChangedListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	publish(chatId: string, projectPath: string | null): void {
		this.#revisions.set(chatId, this.revision(chatId) + 1);
		for (const listener of this.#listeners) listener(chatId, projectPath);
	}

	publishIfChanged(
		chatId: string,
		previousProjectPath: string | undefined,
		projectPath: string,
	): void {
		if (previousProjectPath !== projectPath) this.publish(chatId, projectPath);
	}

	reconcileFetchedRecord(
		next: ChatSessionRecord,
		previous: ChatSessionRecord | undefined,
		capturedRevisions?: ReadonlyMap<string, number>,
	): ChatSessionRecord {
		const requestRevision = capturedRevisions?.get(next.id) ?? 0;
		if (
			previous &&
			capturedRevisions &&
			requestRevision !== this.revision(next.id) &&
			next.projectPath !== previous.projectPath
		) {
			return { ...next, projectPath: previous.projectPath };
		}
		this.publishIfChanged(next.id, previous?.projectPath, next.projectPath);
		return next;
	}
}
