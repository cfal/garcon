import type { ChatSessionRecord } from '$lib/types/chat-session';
import { effectiveNodeId } from '$shared/execution-nodes';

export type ProjectPathChangedListener = (chatId: string, projectPath: string | null, nodeId?: string | null) => void;

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

	publish(chatId: string, projectPath: string | null, nodeId?: string | null): void {
		this.#revisions.set(chatId, this.revision(chatId) + 1);
		for (const listener of this.#listeners) listener(chatId, projectPath, nodeId);
	}

	publishIfChanged(
		chatId: string,
		previousProjectPath: string | undefined,
		projectPath: string,
		previousNodeId?: string | null,
		nodeId?: string | null,
	): void {
		if (previousProjectPath !== projectPath || effectiveNodeId(previousNodeId) !== effectiveNodeId(nodeId)) this.publish(chatId, projectPath, nodeId);
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
			(next.projectPath !== previous.projectPath || effectiveNodeId(next.nodeId) !== effectiveNodeId(previous.nodeId))
		) {
			return { ...next, nodeId: previous.nodeId, projectPath: previous.projectPath };
		}
		this.publishIfChanged(next.id, previous?.projectPath, next.projectPath, previous?.nodeId, next.nodeId);
		return next;
	}
}
