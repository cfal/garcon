import { untrack } from 'svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { SnippetExpansionContext } from '$shared/snippets';
import { projectTargetKey, type ProjectTarget } from '$shared/project-resolution';
import type {
	ProjectResolutionSnapshot,
	ProjectResolutionStore,
} from '$lib/workspace/project-resolution-store.svelte.js';
import * as m from '$lib/paraglide/messages.js';

interface PromptComposerProjectStateDeps {
	readonly selectedChat: ChatSessionRecord | null;
	readonly completionDemand: boolean;
	projectResolution: ProjectResolutionStore;
}

export interface PromptComposerSnippetContext {
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
				return target ? projectTargetKey(target) : null;
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
		return chat.status === 'draft'
			? { kind: 'path', projectPath: chat.projectPath }
			: { kind: 'chat', chatId: chat.id, projectPath: chat.projectPath };
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

	async resolveSnippetContext(): Promise<PromptComposerSnippetContext> {
		const chat = this.deps.selectedChat;
		const projectPath = chat?.projectPath.trim();
		if (!chat || !projectPath) throw new Error(m.chat_new_chat_errors_project_path_required());
		const target: ProjectTarget =
			chat.status === 'draft'
				? { kind: 'path', projectPath }
				: { kind: 'chat', chatId: chat.id, projectPath };
		const lease = this.deps.projectResolution.retain(target);
		try {
			await lease.resolve();
			if (lease.snapshot.kind !== 'available') {
				throw new Error(
					lease.snapshot.kind === 'request-failed'
						? lease.snapshot.message
						: m.workspace_project_unavailable(),
				);
			}
		} finally {
			lease.release();
		}
		if (
			this.deps.selectedChat?.id !== chat.id ||
			this.deps.selectedChat.projectPath.trim() !== projectPath
		) {
			throw new Error(m.workspace_project_changed());
		}
		return {
			context:
				chat.status === 'draft'
					? { type: 'new-chat', chatId: chat.id, projectPath }
					: { type: 'chat', chatId: chat.id },
			chatId: chat.id,
			projectPath,
		};
	}

	destroy(): void {
		this.#destroyEffects();
	}
}
