import { untrack } from 'svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ExpandSnippetResponse, SnippetExpansionContext } from '$shared/snippets';
import { projectTargetKey, type ProjectTarget } from '$shared/project-resolution';
import type {
	ProjectResolutionSnapshot,
	ProjectResolutionStore,
} from '$lib/workspace/project-resolution-store.svelte.js';
import * as m from '$lib/paraglide/messages.js';

interface PromptComposerProjectStateDeps {
	readonly selectedChat: ChatSessionRecord | null;
	readonly executionTarget?: { executorId: string; projectPath: string };
	readonly completionDemand: boolean;
	projectResolution: ProjectResolutionStore;
}

export interface PromptComposerSnippetContext {
	executorId: string;
	context: SnippetExpansionContext;
	chatId: string;
	projectPath: string;
}

export class PromptComposerProjectState {
	readonly #destroyEffects: () => void;

	constructor(private readonly deps: PromptComposerProjectStateDeps) {
		this.#destroyEffects = $effect.root(() => {
			const targetKey = $derived.by(() => {
				const target = this.target;
				return target ? this.deps.projectResolution.lifecycleKey(target) : null;
			});
			$effect(() => {
				if (!targetKey || !this.deps.completionDemand) return;
				const lease = untrack(() => {
					const target = this.target;
					if (!target) return null;
					const retained = this.deps.projectResolution.retain(target);
					void retained.resolve();
					return retained;
				});
				return lease ? () => untrack(() => lease.release()) : undefined;
			});
		});
	}

	get target(): ProjectTarget | null {
		const chat = this.deps.selectedChat;
		if (!chat?.projectPath) return null;
		const execution = this.deps.executionTarget;
		if (
			execution &&
			(execution.executorId !== (chat.executorId ?? 'local') || execution.projectPath !== chat.projectPath)
		) {
			return { kind: 'path', ...execution };
		}
		return chat.status === 'draft'
			? { kind: 'path', executorId: chat.executorId, projectPath: chat.projectPath }
			: { kind: 'chat', chatId: chat.id, executorId: chat.executorId, projectPath: chat.projectPath };
	}

	get snapshot(): ProjectResolutionSnapshot {
		const target = this.target;
		return target ? this.deps.projectResolution.snapshotFor(target) : { kind: 'unchecked' };
	}

	get completionProjectPath(): string {
		return this.snapshot.kind === 'available' ? (this.target?.projectPath ?? '') : '';
	}

	retry(): void {
		const target = this.target;
		if (!target) return;
		const lease = this.deps.projectResolution.retain(target);
		void lease.retry().finally(() => lease.release());
	}

	matchesSnippetContext(operation: PromptComposerSnippetContext, response: Pick<ExpandSnippetResponse, 'contextExecutorId' | 'contextProjectPath'>): boolean {
		return this.deps.selectedChat?.id === operation.chatId
			&& this.target?.projectPath.trim() === operation.projectPath
			&& (this.target?.executorId ?? 'local') === operation.executorId
			&& response.contextExecutorId === operation.executorId
			&& response.contextProjectPath === operation.projectPath;
	}

	async resolveSnippetContext(signal?: AbortSignal): Promise<PromptComposerSnippetContext> {
		const chat = this.deps.selectedChat;
		const target = this.target;
		const projectPath = target?.projectPath.trim();
		const executorId = target?.executorId ?? 'local';
		if (!chat || !target || !projectPath) throw new Error(m.chat_new_chat_errors_project_path_required());
		signal?.throwIfAborted();
		const lease = this.deps.projectResolution.retain(target);
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			lease.release();
		};
		let rejectAbort: ((reason: unknown) => void) | null = null;
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = reject;
		});
		const releaseOnAbort = () => {
			release();
			rejectAbort?.(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', releaseOnAbort, { once: true });
		try {
			if (signal?.aborted) releaseOnAbort();
			await (signal ? Promise.race([lease.resolve(), aborted]) : lease.resolve());
			signal?.throwIfAborted();
			if (
				this.deps.selectedChat?.id !== chat.id ||
				!this.target || projectTargetKey(this.target) !== projectTargetKey(target)
			) {
				throw new Error(m.workspace_project_changed());
			}
			if (lease.snapshot.kind !== 'available') {
				throw new Error(
					lease.snapshot.kind === 'request-failed'
						? lease.snapshot.message
						: m.workspace_project_unavailable(),
				);
			}
		} finally {
			signal?.removeEventListener('abort', releaseOnAbort);
			release();
		}
		return {
			executorId,
			context:
				target.kind === 'path'
					? { type: 'new-chat', chatId: chat.id, executorId, projectPath }
					: { type: 'chat', chatId: chat.id },
			chatId: chat.id,
			projectPath,
		};
	}

	destroy(): void {
		this.#destroyEffects();
	}
}
